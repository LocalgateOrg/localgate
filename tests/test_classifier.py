import numpy as np
import pytest
from localgate_daemon.classifier import CentroidClassifier, match_rule, route_from_margin

# Mirrors the long-context cut-off in classifier.decide(); the boundary tests below only
# mean anything if this stays in step with the source.
MAX_PROMPT_CHARS = 4000


class FakeEmbedder:
    def embed(self, documents):
        for document in documents:
            text = document.lower()
            if any(word in text for word in ("recursion", "friendly", "translate")):
                yield np.array([1.0, 0.0], dtype=np.float32)
            else:
                yield np.array([0.0, 1.0], dtype=np.float32)


class HandPickedVectorEmbedder:
    """Pins the exemplar axes so the prompt vector alone fixes the margin arithmetic."""

    def __init__(self, prompt_vector: list[float]) -> None:
        self._prompt_vector = prompt_vector

    def embed(self, documents):
        for document in documents:
            if document == "simple":
                yield np.array([1.0, 0.0], dtype=np.float32)
            elif document == "complex":
                yield np.array([0.0, 1.0], dtype=np.float32)
            else:
                yield np.array(self._prompt_vector, dtype=np.float32)


def make_classifier() -> CentroidClassifier:
    return CentroidClassifier(
        model_name="fake",
        threshold=0.05,
        embedder=FakeEmbedder(),
        simple_examples=["Explain recursion.", "Write a friendly note."],
        complex_examples=["Research latest law.", "Analyze a repository."],
    )


def test_simple_prompt_routes_local() -> None:
    result = make_classifier().classify("Explain recursion in simple terms.")

    assert result.route == "local"
    assert result.reason == "centroid_simple"


def test_current_prompt_routes_cloud() -> None:
    result = make_classifier().classify("What are the latest AI news stories today?")

    assert result.route == "cloud"
    assert result.reason == "rule_realtime_required"


def test_web_prompt_routes_cloud() -> None:
    result = make_classifier().classify("Search the web and cite sources.")

    assert result.route == "cloud"
    assert result.reason == "rule_web_required"


def test_tool_prompt_routes_cloud() -> None:
    result = make_classifier().classify("Run this command and deploy the project.")

    assert result.route == "cloud"
    assert result.reason == "rule_tool_use"


def test_file_prompt_routes_cloud() -> None:
    result = make_classifier().classify("Analyze this PDF and the attached file.")

    assert result.route == "cloud"
    assert result.reason == "rule_file_required"


def test_multimodal_prompt_routes_cloud() -> None:
    result = make_classifier().classify("Use this screenshot to explain the error.")

    assert result.route == "cloud"
    assert result.reason == "rule_multimodal"


def test_high_stakes_prompt_routes_cloud() -> None:
    result = make_classifier().classify("Give me medical advice for chest pain.")

    assert result.route == "cloud"
    assert result.reason == "rule_high_stakes"


def test_complex_research_prompt_routes_cloud() -> None:
    result = make_classifier().classify("Write a systematic review comparing studies.")

    assert result.route == "cloud"
    assert result.reason == "rule_complex_research"


def test_draft_email_does_not_match_tool_rule() -> None:
    assert match_rule("Draft an email thanking my professor.") is None


def test_send_email_matches_tool_rule() -> None:
    assert match_rule("Send an email to my professor.") == "rule_tool_use"


def test_sources_of_inspiration_does_not_match_web_rule() -> None:
    assert match_rule("Give me sources of inspiration for a poem.") is None


def test_cite_sources_matches_web_rule() -> None:
    assert match_rule("Cite sources for this claim.") == "rule_web_required"


def test_electric_current_does_not_match_realtime_rule() -> None:
    assert match_rule("Explain electric current.") is None


def test_latest_news_matches_realtime_rule() -> None:
    assert match_rule("What is the latest AI news today?") == "rule_realtime_required"


def test_repository_definition_does_not_match_file_rule() -> None:
    assert match_rule("Explain what a repository is.") is None


def test_analyze_repository_matches_file_rule() -> None:
    assert match_rule("Analyze this repository.") == "rule_file_required"


def test_image_compression_does_not_match_multimodal_rule() -> None:
    assert match_rule("Describe an image compression algorithm.") is None


def test_screenshot_matches_multimodal_rule() -> None:
    assert match_rule("Use this screenshot to explain the error.") == "rule_multimodal"


def test_photosynthesis_does_not_match_multimodal_rule() -> None:
    # "photo" must not match inside "photosynthesis" — rules trigger on whole words.
    assert match_rule("Explain photosynthesis to a child.") is None


def test_photo_as_a_word_still_matches_multimodal_rule() -> None:
    assert match_rule("Use this photo to explain the plant.") == "rule_multimodal"


def test_doing_does_not_match_doi_rule() -> None:
    # "doi" must not match inside "doing".
    assert match_rule("What am I doing wrong here?") is None


def test_rule_trigger_late_in_a_long_prompt_still_routes_cloud() -> None:
    # The rule scan must read the whole prompt. Truncating it would let a high-stakes
    # trigger buried past the opening sentences fall through to the centroid, which for
    # this filler answers "local" — the exact failure CLAUDE.md's cloud-default forbids.
    filler = "Explain recursion in simple terms. " * 40  # 1400 benign characters
    long_prompt = filler + "Also, give me medical advice for chest pain."
    assert long_prompt.index("medical advice") > 1000
    assert len(long_prompt) < MAX_PROMPT_CHARS

    decision = make_classifier().decide(long_prompt)

    assert decision.route == "cloud"
    assert decision.reason == "rule_high_stakes"
    assert decision.margin is None


def test_realtime_trigger_late_in_a_long_prompt_still_routes_cloud() -> None:
    filler = "Explain recursion in simple terms. " * 40
    long_prompt = filler + "What changed today?"

    decision = make_classifier().decide(long_prompt)

    assert decision.route == "cloud"
    assert decision.reason == "rule_realtime_required"


def test_prompt_at_the_length_limit_still_reaches_the_centroid() -> None:
    # Exactly 4000 characters: the limit is exclusive, so this must not be called long.
    at_limit = "recursion " * 400
    assert len(at_limit) == MAX_PROMPT_CHARS

    result = make_classifier().classify(at_limit)

    assert result.route == "local"
    assert result.reason == "centroid_simple"


def test_prompt_one_character_over_the_limit_routes_cloud() -> None:
    over_limit = "recursion " * 400 + "x"
    assert len(over_limit) == MAX_PROMPT_CHARS + 1

    result = make_classifier().classify(over_limit)

    assert result.route == "cloud"
    assert result.reason == "rule_long_context"
    assert result.confidence == 1.0


def test_ambiguous_margin_falls_back_to_cloud() -> None:
    class AmbiguousEmbedder:
        """Returns the same vector for everything, so both centroids are identical."""

        def embed(self, documents):
            for _ in documents:
                yield np.array([1.0, 0.0], dtype=np.float32)

    classifier = CentroidClassifier(
        model_name="fake",
        threshold=0.05,
        embedder=AmbiguousEmbedder(),
        simple_examples=["a"],
        complex_examples=["b"],
    )
    result = classifier.classify("anything")

    assert result.route == "cloud"
    assert result.reason == "ambiguous_fallback"


def test_embedder_error_falls_back_to_cloud() -> None:
    class BrokenEmbedder:
        """Raises on every call to simulate a broken embedding model."""

        def embed(self, documents):
            raise RuntimeError("model failed to load")

    classifier = CentroidClassifier(
        model_name="fake",
        threshold=0.05,
        embedder=BrokenEmbedder(),
        simple_examples=["a"],
        complex_examples=["b"],
    )
    result = classifier.classify("anything")

    assert result.route == "cloud"
    assert result.reason == "error_fallback"
    assert result.confidence == 0.0


def test_decide_records_signed_margin_for_centroid_route() -> None:
    decision = make_classifier().decide("Explain recursion in simple terms.")

    assert decision.reason == "centroid_simple"
    assert decision.margin is not None
    assert decision.margin > 0


def test_decide_leaves_margin_none_for_rule_route() -> None:
    decision = make_classifier().decide("Send an email to my professor.")

    assert decision.reason == "rule_tool_use"
    assert decision.margin is None


def test_route_from_margin_thresholds() -> None:
    # Below threshold -> ambiguous -> cloud, regardless of sign.
    assert route_from_margin(0.02, 0.05) == ("cloud", "ambiguous_fallback")
    assert route_from_margin(-0.02, 0.05) == ("cloud", "ambiguous_fallback")
    # Above threshold: sign decides.
    assert route_from_margin(0.2, 0.05) == ("local", "centroid_simple")
    assert route_from_margin(-0.2, 0.05) == ("cloud", "centroid_complex")


def test_margin_exactly_at_the_threshold_is_not_ambiguous() -> None:
    # The comparison is strict, so a margin equal to the threshold clears it and the sign
    # decides. Loosening this to <= would drag the whole boundary onto the cloud side.
    assert route_from_margin(0.05, 0.05) == ("local", "centroid_simple")
    assert route_from_margin(-0.05, 0.05) == ("cloud", "centroid_complex")


def test_zero_threshold_routes_every_nonzero_margin_by_sign() -> None:
    assert route_from_margin(0.0001, 0.0) == ("local", "centroid_simple")
    assert route_from_margin(-0.0001, 0.0) == ("cloud", "centroid_complex")


def test_decide_applies_the_configured_threshold_to_the_same_margin() -> None:
    # Unit prompt vector [0.8, 0.6] against centroids [1, 0] and [0, 1] gives a margin of
    # 0.8 - 0.6 = 0.2 by hand. A threshold either side of it must flip the route.
    def make(threshold: float) -> CentroidClassifier:
        return CentroidClassifier(
            model_name="fake",
            threshold=threshold,
            embedder=HandPickedVectorEmbedder([0.8, 0.6]),
            simple_examples=["simple"],
            complex_examples=["complex"],
        )

    permissive = make(0.1).decide("prompt")
    strict = make(0.3).decide("prompt")

    assert permissive.margin == pytest.approx(0.2, abs=1e-6)
    assert permissive.confidence == pytest.approx(0.2, abs=1e-6)
    assert (permissive.route, permissive.reason) == ("local", "centroid_simple")
    assert strict.margin == pytest.approx(0.2, abs=1e-6)
    assert (strict.route, strict.reason) == ("cloud", "ambiguous_fallback")


def test_decide_routes_a_negative_margin_above_the_threshold_to_the_complex_centroid() -> None:
    classifier = CentroidClassifier(
        model_name="fake",
        threshold=0.1,
        embedder=HandPickedVectorEmbedder([0.6, 0.8]),
        simple_examples=["simple"],
        complex_examples=["complex"],
    )

    decision = classifier.decide("prompt")

    assert decision.margin == pytest.approx(-0.2, abs=1e-6)
    assert decision.confidence == pytest.approx(0.2, abs=1e-6)
    assert (decision.route, decision.reason) == ("cloud", "centroid_complex")


def test_loaded_is_false_before_first_classify() -> None:
    classifier = make_classifier()

    assert classifier.loaded is False

    classifier.classify("Explain recursion.")

    assert classifier.loaded is True
