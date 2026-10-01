"""Routing classifier: hard rules first, then embedding centroid similarity."""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from time import perf_counter

import numpy as np

from .classifier_data import COMPLEX_EXAMPLES, RULES, SIMPLE_EXAMPLES
from .schemas import MAX_PROMPT_CHARS, ClassifyResponse, Route, RouteReason


@dataclass(frozen=True)
class Decision:
    route: Route
    confidence: float
    reason: RouteReason
    # Signed centroid margin (simple - complex); None for rule/long-context/error decisions.
    # Kept so offline evaluation can sweep thresholds without re-embedding; the live API
    # response does not expose it.
    margin: float | None = None


class CentroidClassifier:

    def __init__(
        self,
        model_name: str,
        threshold: float,
        embedder: object | None = None,
        simple_examples: Sequence[str] | None = None,
        complex_examples: Sequence[str] | None = None,
    ) -> None:
        self.model_name = model_name
        self.threshold = threshold
        self._embedder = embedder
        self._simple_examples = simple_examples or SIMPLE_EXAMPLES
        self._complex_examples = complex_examples or COMPLEX_EXAMPLES
        self._simple_centroid: np.ndarray | None = None
        self._complex_centroid: np.ndarray | None = None

    @property
    def loaded(self) -> bool:
        return self._simple_centroid is not None and self._complex_centroid is not None

    def warm_up(self) -> None:
        """Build centroids eagerly; the first build downloads the embedding model."""
        self._ensure_centroids()

    def classify(self, prompt: str) -> ClassifyResponse:
        start = perf_counter()
        decision = self.decide(prompt)
        latency_ms = (perf_counter() - start) * 1000

        return ClassifyResponse(
            route=decision.route,
            confidence=decision.confidence,
            reason=decision.reason,
            latency_ms=round(latency_ms, 3),
        )

    def decide(self, prompt: str) -> Decision:
        """Hard rules first, then embedding-based centroid comparison."""
        rule_reason = match_rule(prompt)
        if rule_reason is not None:
            return Decision(route="cloud", confidence=1.0, reason=rule_reason)

        if len(prompt) > MAX_PROMPT_CHARS:
            return Decision(route="cloud", confidence=1.0, reason="rule_long_context")

        try:
            self._ensure_centroids()
            prompt_vector = self._embed(prompt)
            simple_score = cosine_similarity(prompt_vector, self._simple_centroid)
            complex_score = cosine_similarity(prompt_vector, self._complex_centroid)
            # Positive margin means closer to the simple centroid.
            margin = simple_score - complex_score
        except Exception:
            # Any embedding failure (incl. OSError on first model load) routes cloud
            # rather than risk a wrong local answer.
            return Decision(route="cloud", confidence=0.0, reason="error_fallback")

        confidence = min(1.0, abs(margin))

        # The threshold rule lives in route_from_margin so the offline evaluation harness
        # can replay it over many thresholds from the recorded margin alone.
        route, reason = route_from_margin(margin, self.threshold)
        return Decision(route=route, confidence=confidence, reason=reason, margin=margin)

    def _ensure_centroids(self) -> None:
        if self.loaded:
            return

        simple_vectors = []
        for text in self._simple_examples:
            simple_vectors.append(self._embed(text))

        complex_vectors = []
        for text in self._complex_examples:
            complex_vectors.append(self._embed(text))

        self._simple_centroid = normalize(np.vstack(simple_vectors).mean(axis=0))
        self._complex_centroid = normalize(np.vstack(complex_vectors).mean(axis=0))

    def _embed(self, text: str) -> np.ndarray:
        """Embed one string and return a unit-length float32 vector."""
        embeddings = list(self._get_embedder().embed([text]))

        if not embeddings:
            raise ValueError("embedding model returned no vectors")

        vector = np.asarray(embeddings[0], dtype=np.float32)

        return normalize(vector)

    def _get_embedder(self) -> object:
        if self._embedder is None:
            # Lazy import: loading fastembed (and the model download it may trigger)
            # would otherwise slow daemon startup.
            from fastembed import TextEmbedding

            self._embedder = TextEmbedding(model_name=self.model_name)
        return self._embedder


# Shared by decide() and the offline evaluation harness so a threshold sweep replays
# exactly the live decision rule. Below the threshold the margin is ambiguous -> cloud.
def route_from_margin(margin: float, threshold: float) -> tuple[Route, RouteReason]:
    if abs(margin) < threshold:
        return "cloud", "ambiguous_fallback"
    if margin > 0:
        return "local", "centroid_simple"
    return "cloud", "centroid_complex"


# Keywords compile once into a single word-boundary regex per rule: whole words and
# phrases only, so "photo" does not match inside "photosynthesis".
def _compile_rule_patterns(
    rules: tuple[tuple[RouteReason, tuple[str, ...]], ...],
) -> tuple[tuple[RouteReason, re.Pattern[str]], ...]:
    compiled = []
    for reason, keywords in rules:
        alternatives = "|".join(re.escape(keyword) for keyword in keywords)
        compiled.append((reason, re.compile(rf"\b(?:{alternatives})\b")))
    return tuple(compiled)


_RULE_PATTERNS = _compile_rule_patterns(RULES)


def match_rule(prompt: str) -> RouteReason | None:
    """Return the first rule whose keyword appears as a whole word/phrase, else None."""
    text = prompt.lower()
    for reason, pattern in _RULE_PATTERNS:
        if pattern.search(text):
            return reason
    return None


# Cosine similarity assumes unit-length vectors.
def normalize(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)

    if norm == 0:
        raise ValueError("zero vector cannot be normalized")

    unit_vector = vector / norm

    return unit_vector


# Inputs are already normalized, so the dot product equals cosine similarity.
def cosine_similarity(left: np.ndarray, right: np.ndarray | None) -> float:
    if right is None:
        raise ValueError("centroid has not been initialized")

    similarity = float(np.dot(left, right))

    return similarity
