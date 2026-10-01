"""Exemplar prompts for the two centroids and the hard cloud-routing rules."""

from .schemas import RouteReason

# Local-friendly prompts assume the needed context is already in the text LocalGate sends.
SIMPLE_EXAMPLES: tuple[str, ...] = (
    "Explain recursion in simple terms.",
    "Summarize this paragraph in two sentences.",
    "Write a friendly email thanking a professor.",
    "Give me three ideas for reducing household electricity use.",
    "Translate this sentence into Spanish.",
    "What is a Python list comprehension?",
    "Rewrite this sentence to sound more professional.",
    "Make this message shorter and clearer.",
    "Suggest a better title for this short note.",
    "Brainstorm five names for a campus sustainability club.",
    "Explain the difference between latency and throughput.",
    "Turn these bullet points into a short paragraph.",
    "Give me a simple example of a for loop in Python.",
    "Explain what an HTTP status code is.",
    "Draft a polite follow-up message after a meeting.",
    "Convert this informal text into formal writing.",
    "List three pros and cons of studying with flashcards.",
    "Explain cosine similarity without equations.",
    "Help me outline a short presentation introduction.",
    "Check this short sentence for grammar.",
)


# Cloud-oriented prompts need current data, external tools, risky advice, or unsupported inputs.
COMPLEX_EXAMPLES: tuple[str, ...] = (
    "Research the latest EU AI Act enforcement updates and cite sources.",
    "Analyze these five project files and fix the failing tests.",
    "Give medical advice for chest pain.",
    "Search the web for current stock prices.",
    "Use this screenshot to debug the website.",
    "Compare recent arXiv papers about LLM routing.",
    "Review the attached contract and tell me if it is legally safe to sign.",
    "Read this uploaded PDF and extract the main claims.",
    "Use the current weather forecast to plan my trip tomorrow.",
    "Find recent benchmark results for local LLM routers and cite papers.",
    "Diagnose this rash from the photo I uploaded.",
    "Create an investment plan based on today's market conditions.",
    "Run the test suite, inspect the failures, and patch the repository.",
    "Call the API and summarize the response payload.",
    "Compare the latest model releases from OpenAI, Anthropic, and Google.",
    "Analyze this spreadsheet and identify the biggest spending categories.",
    "Write a full literature review on carbon-aware LLM serving.",
    "Deploy this app and verify the production logs.",
    "Audit this codebase for security issues across all modules.",
    "Use web sources to check whether this claim is still accurate.",
)

# Checked before the centroid stage; a match always forces cloud — no rule routes
# locally. The first matching rule wins, so ordering matters.
RULES: tuple[tuple[RouteReason, tuple[str, ...]], ...] = (
    (
        "rule_web_required",
        (
            "search the web",
            "browse the web",
            "look up",
            "google",
            "online sources",
            "cite sources",
            "provide sources",
            "provide citations",
            "with citations",
            "web sources",
            "academic sources",
            "arxiv",
            "acm",
            "doi",
        ),
    ),
    (
        "rule_realtime_required",
        (
            "today",
            "latest",
            "as of now",
            "this week",
            "this month",
            "breaking",
            "breaking news",
            "current events",
            "recent news",
        ),
    ),
    (
        "rule_tool_use",
        (
            "run this command",
            "execute code",
            "api call",
            "call the api",
            "use a tool",
            "send an email",
            "send email",
            "deploy",
            "install package",
        ),
    ),
    (
        "rule_file_required",
        (
            "attached file",
            "uploaded file",
            "analyze this pdf",
            "analyze this spreadsheet",
            "analyze this csv",
            "analyze this file",
            "multi-file",
            "analyze this repository",
            "this codebase",
        ),
    ),
    (
        "rule_multimodal",
        (
            "this image",
            "attached image",
            "screenshot",
            "photo",
            "diagram",
            "video",
            "audio",
            "chart in this image",
        ),
    ),
    (
        "rule_high_stakes",
        (
            "medical advice",
            "legal advice",
            "financial advice",
            "diagnose",
            "prescription",
            "lawsuit",
            "investment",
            "tax advice",
        ),
    ),
    (
        "rule_complex_research",
        (
            "literature review",
            "systematic review",
            "research paper",
            "compare studies",
            "state of the art",
            "meta-analysis",
        ),
    ),
)
