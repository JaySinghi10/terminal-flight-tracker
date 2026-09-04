"""Which Claude the service talks to, and how it authenticates.

NOTHING ELSE IN THIS CODEBASE CONSTRUCTS A CLAUDE CLIENT. api.py asks this
module for one and reads the two model names from it; mcp_server.py does not
know this file exists. The same separation store.py keeps for the bucket, and
for the same reason: the provider decision lives in one place, so changing it
cannot mean finding every call site.

TWO PROVIDERS BEHIND ONE ENVIRONMENT VARIABLE. LLM_PROVIDER is "vertex" or
"anthropic" and nothing else in the codebase asks which. The request bodies,
the tool schemas and the response parsing are IDENTICAL either way -- that is
the property that makes this abstraction three functions rather than a layer.
Pointing back at Anthropic direct is one variable and a redeploy.

AUTHENTICATION ON VERTEX IS THE RUNTIME SERVICE ACCOUNT'S, exactly as it is for
the bucket. Application Default Credentials on Cloud Run resolve to the
service's own identity through the metadata server; on a developer machine they
come from `gcloud auth application-default login`. There is no key file and no
credentials environment variable, and there must never be one. The account does
need the Vertex AI User role -- storage permissions alone are not enough, and
the failure is a 403 at the first call rather than anything at boot.

UNCONFIGURED IS A VALID STATE, and this module is imported for its constants
before it is ever asked for a client. A missing project id or a missing API key
raises when a client is FIRST ASKED FOR, not at import, so the service still
boots and /flight, /route and /quota -- which never call a model -- are
untouched by a misconfiguration they have nothing to do with.
"""
import os
import threading

import anthropic

# ──────────────────────────────────────────────
# CONFIGURATION
# ──────────────────────────────────────────────
PROVIDER = (os.getenv("LLM_PROVIDER") or "vertex").strip().lower()

# Vertex resolves the project from Application Default Credentials in principle
# and NOT IN PRACTICE: the client builds the request URL, which contains the
# project, before it does the auth exchange that would discover one, so a client
# left to infer it raises on its first call rather than working. It is required
# here, and named as such.
VERTEX_PROJECT_ID = (os.getenv("VERTEX_PROJECT_ID") or "").strip()

# "global" lets Google route the request and is the recommended setting. It is
# also the answer to whether this service's own region matters: it does not.
# Cloud Run runs in asia-south1 and calls whichever Vertex endpoint this names,
# which is an ordinary cross-region API call. A specific region here would be
# for data residency, and would then have to be one Claude is actually served
# from -- which is the constraint "global" exists to avoid.
VERTEX_REGION = (os.getenv("VERTEX_REGION") or "global").strip()

ANTHROPIC_API_KEY = (os.getenv("ANTHROPIC_API_KEY") or "").strip()

# THE MODEL IDS ARE CONFIGURATION, NOT CODE. They differ between providers in a
# way that is easy to get wrong and impossible to catch by reading: a CURRENT
# model is the same bare string on both -- "claude-sonnet-5" -- but a PINNED
# SNAPSHOT separates the date with a hyphen on Anthropic direct and an AT SIGN
# on Vertex. "claude-haiku-4-5-20251001" is valid on one and rejected by the
# other, where it would be "claude-haiku-4-5@20251001". Vertex takes no vendor
# prefix at all, unlike Bedrock.
#
# The defaults are the unpinned current models, which are correct on both. Set
# the variables to pin.
CHAT_MODEL = (os.getenv("CHAT_MODEL") or "claude-sonnet-5").strip()
PARSE_MODEL = (os.getenv("PARSE_MODEL") or "claude-haiku-4-5").strip()


# ──────────────────────────────────────────────
# THE CLIENT
# ──────────────────────────────────────────────
# BUILT ONCE, NOT PER REQUEST. Both endpoints used to construct a client inside
# the handler, which threw away a connection pool on every call. On Vertex that
# is worse than wasteful: constructing a client resolves credentials, so a
# per-request client is a metadata-server round trip per request. Built lazily
# rather than at import so a misconfiguration cannot stop the service booting,
# and under a lock because FastAPI runs these sync handlers in a thread pool.
_client = None
_lock = threading.Lock()


def client():
    """The shared client for the configured provider.

    Raises if the provider is not configured. Both call sites already run the
    model call inside a try that turns any exception into a fixed user-facing
    string and a log line, so a misconfiguration is reported the same way a
    provider outage is -- and never in the provider's own words.
    """
    global _client
    if _client is not None:
        return _client
    with _lock:
        if _client is None:
            _client = _build()
    return _client


def _build():
    if PROVIDER == "vertex":
        if not VERTEX_PROJECT_ID:
            raise RuntimeError("VERTEX_PROJECT_ID is not set")
        # Passed explicitly rather than through the CLOUD_ML_REGION and
        # ANTHROPIC_VERTEX_PROJECT_ID variables the SDK also reads, so that
        # everything this service's provider choice depends on is named in this
        # file and visible in one place.
        return anthropic.AnthropicVertex(
            project_id=VERTEX_PROJECT_ID,
            region=VERTEX_REGION,
        )
    if PROVIDER == "anthropic":
        if not ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    raise RuntimeError(f"LLM_PROVIDER is not a provider this service knows: {PROVIDER!r}")
