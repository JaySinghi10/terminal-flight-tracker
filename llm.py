"""Which model this service talks to, and the one shape it talks in.

NOTHING ELSE IN THIS CODEBASE KNOWS WHICH PROVIDER IS IN USE. api.py builds a
request out of the neutral pieces below and reads a neutral answer back;
mcp_server.py does not know this file exists. The same separation store.py keeps
for the bucket, and for the same reason: the provider decision lives in one
place, so changing it cannot mean finding every call site.

THREE PROVIDERS, ONE ENVIRONMENT VARIABLE. LLM_PROVIDER is "gemini", "vertex" or
"anthropic".

  gemini     Google's Gemini API, on an API key. The one in use.
  vertex     Claude through Google Vertex AI, on the Cloud Run service account.
  anthropic  Claude direct, on an Anthropic API key. The fallback.

WHY THIS FILE GREW A TRANSLATION LAYER, having previously been three functions.
Vertex and Anthropic direct take IDENTICAL request bodies and return IDENTICAL
objects, so switching between them was a matter of construction and nothing
else. Gemini shares none of that: different tool declarations, different message
shape, different response structure, different error classes, and a control flow
that answers "is there a function call here" rather than "why did it stop".

SO THE CHOICE WAS WHERE THE DIFFERENCE LIVES, and it is here rather than in the
endpoints. The alternative was an if/else at each of the two call sites, which
would have meant two copies of the tool loop and a fallback path that rots
silently because nobody runs it. One loop in api.py, one translation per
provider here, and the fallback stays honest because it is the same loop.

WHAT IS NEUTRAL AND WHAT IS NOT. The tool declarations api.py passes are in
Anthropic's shape -- name, description, input_schema -- because that is what
they were already written in and rewriting them would have been churn for its
own sake. That shape is this file's INTERFACE, not a statement about which
provider is in use; the Gemini translator converts it.

AUTHENTICATION. Gemini and Anthropic direct take an API key from the
environment. Vertex takes no key at all: Application Default Credentials resolve
to the Cloud Run service account, exactly as store.py's bucket client does.

UNCONFIGURED IS A VALID STATE, and this module is imported for its constants
before it is ever asked for a client. A missing key raises when a client is
FIRST ASKED FOR, not at import, so the service still boots and /flight, /route
and /quota -- which never call a model -- are untouched by a misconfiguration
they have nothing to do with.
"""
import os
import threading
from dataclasses import dataclass, field
from typing import Any

import anthropic

# ──────────────────────────────────────────────
# CONFIGURATION
# ──────────────────────────────────────────────
PROVIDER = (os.getenv("LLM_PROVIDER") or "gemini").strip().lower()

GEMINI_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()

# Vertex resolves the project from Application Default Credentials in principle
# and NOT IN PRACTICE: the client builds the request URL, which contains the
# project, before it does the auth exchange that would discover one, so a client
# left to infer it raises on its first call rather than working. It is required
# there, and named as such.
VERTEX_PROJECT_ID = (os.getenv("VERTEX_PROJECT_ID") or "").strip()

# "global" lets Google route the request and is the recommended setting. It is
# also the answer to whether this service's own region matters: it does not.
VERTEX_REGION = (os.getenv("VERTEX_REGION") or "global").strip()

ANTHROPIC_API_KEY = (os.getenv("ANTHROPIC_API_KEY") or "").strip()

# THE MODEL IDS ARE CONFIGURATION, and the defaults have to follow the provider
# because a Claude id means nothing to Gemini and the reverse. Setting
# LLM_PROVIDER alone therefore gives a working pair rather than a 404.
#
# ON VERTEX A PINNED SNAPSHOT SPELLS ITS DATE DIFFERENTLY: claude-haiku-4-5 is
# claude-haiku-4-5-20251001 on Anthropic direct and claude-haiku-4-5@20251001 on
# Vertex -- an at sign, not a hyphen. Current models are the same bare string on
# both. Vertex takes no vendor prefix at all, unlike Bedrock.
#
# gemini-3.8-flash WAS READ OFF THE MODELS ENDPOINT rather than typed from
# memory, which is the only way to be sure of one.
_DEFAULT_MODELS = {
    "gemini": ("gemini-3.8-flash", "gemini-3.8-flash"),
    "vertex": ("claude-sonnet-5", "claude-haiku-4-5"),
    "anthropic": ("claude-sonnet-5", "claude-haiku-4-5"),
}
_chat_default, _parse_default = _DEFAULT_MODELS.get(PROVIDER, ("", ""))

CHAT_MODEL = (os.getenv("CHAT_MODEL") or _chat_default).strip()
PARSE_MODEL = (os.getenv("PARSE_MODEL") or _parse_default).strip()

# WHICH FAMILY OF SDK THIS PROVIDER SPEAKS. Two of the three are the same wire
# format, and every translation below branches on this rather than on PROVIDER,
# so adding a second Claude host would need no new branch anywhere.
_ANTHROPIC_FAMILY = ("vertex", "anthropic")


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
    if PROVIDER == "gemini":
        if not GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY is not set")
        # IMPORTED HERE RATHER THAN AT MODULE SCOPE, so that a deployment
        # running Claude does not have to have google-genai installed to import
        # this file. The same courtesy is not extended to anthropic, which is
        # imported at the top because failure_kind() needs its exception classes
        # whatever the provider is.
        from google import genai
        return genai.Client(api_key=GEMINI_API_KEY)
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


# ──────────────────────────────────────────────
# WHAT A TURN LOOKS LIKE, WHICHEVER PROVIDER PRODUCED IT
# ──────────────────────────────────────────────
@dataclass
class ToolCall:
    """One request from the model to run one tool.

    `id` IS OPTIONAL AND THAT IS NOT AN OVERSIGHT. Anthropic always sends one and
    requires it back on the matching result. Gemini frequently omits it and
    matches on the function NAME instead, so a None here is normal rather than a
    missing value, and the result builder below sends the id only when there is
    one to send.
    """
    name: str
    args: dict
    id: str | None = None


@dataclass
class Turn:
    """One answer from the model, in the only shape api.py knows about.

    `text` and `tool_calls` are BOTH ALWAYS PRESENT and either may be empty. The
    endpoint decides what that combination means; this file does not, because
    "no text and no calls" is a different problem on each provider and none of
    them is this layer's to interpret.

    `raw` IS THE PROVIDER'S OWN TURN OBJECT, kept so it can be handed straight
    back on the next round rather than rebuilt from the fields above. On Gemini 3
    that is load-bearing: parts carry thought signatures which must survive the
    round trip, and reconstructing a turn from its text and its function calls
    silently drops them. Nothing outside this file should look inside it.
    """
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw: Any = None


# ──────────────────────────────────────────────
# BUILDING A CONVERSATION
# ──────────────────────────────────────────────
#
# A MESSAGE IS A TAGGED DICT UNTIL THE MOMENT IT IS SENT. api.py appends these
# in order and never inspects them; each translator turns the whole list into
# whatever its SDK wants at call time. The alternative -- api.py building native
# messages -- is the thing this file exists to prevent.
def user_text(text: str) -> dict:
    """The user said this."""
    return {"kind": "user_text", "text": text}


def model_turn(turn: Turn) -> dict:
    """The model said this. Carries the provider's own object, see Turn.raw."""
    return {"kind": "raw", "value": turn.raw}


def tool_results(results: list[tuple[ToolCall, str]]) -> dict:
    """These tools ran and this is what they said.

    ONE MESSAGE FOR ALL OF THEM, because both providers expect the results of a
    round of parallel calls to arrive together rather than one message each.
    """
    return {"kind": "tool_results", "results": results}


# ──────────────────────────────────────────────
# THE CALL
# ──────────────────────────────────────────────
def generate(
    *,
    model: str,
    system: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    forced_tool: str | None = None,
    max_tokens: int,
    temperature: float | None = None,
    thinking: bool = True,
) -> Turn:
    """One round trip to the model. Provider-neutral in and provider-neutral out.

    `tools` are in Anthropic's declaration shape -- name, description,
    input_schema -- which is this file's interface rather than a claim about the
    provider. See the note at the top.

    `forced_tool` names a tool the model MUST call. Both providers can express
    it; the mechanisms have nothing in common.

    `temperature` is passed only where the provider accepts one. See each
    translator for what that costs.

    `thinking` FALSE ASKS FOR AS LITTLE REASONING AS THE MODEL ALLOWS, and it
    exists because of what thinking costs against `max_tokens`. On Gemini 3 the
    two share one budget: a call with a 256-token ceiling spent 489 on thinking,
    ran out mid-function-call and came back MALFORMED_FUNCTION_CALL with nothing
    usable. Extraction against a closed schema earns nothing from reasoning, so
    /parse turns it down and fits; /chat leaves it on and pays for the room.

    IT IS "MINIMISED", NOT "OFF", and the name of the parameter is the only
    place that can say so: asking for a zero budget still produced ~100 tokens
    of thought. It is a request, not a switch.
    """
    if PROVIDER in _ANTHROPIC_FAMILY:
        return _generate_anthropic(
            model=model, system=system, messages=messages, tools=tools,
            forced_tool=forced_tool, max_tokens=max_tokens,
            temperature=temperature, thinking=thinking)
    if PROVIDER == "gemini":
        return _generate_gemini(
            model=model, system=system, messages=messages, tools=tools,
            forced_tool=forced_tool, max_tokens=max_tokens,
            temperature=temperature, thinking=thinking)
    raise RuntimeError(f"LLM_PROVIDER is not a provider this service knows: {PROVIDER!r}")


# ── ANTHROPIC, WHICH IS ALSO VERTEX ─────────────────────────────────────────
def _generate_anthropic(*, model, system, messages, tools, forced_tool,
                        max_tokens, temperature, thinking) -> Turn:
    # `thinking` IS ACCEPTED AND DOES NOTHING HERE, deliberately. Claude's
    # extended thinking is OPT-IN -- absent a thinking block the model does not
    # reason at length and nothing is billed against max_tokens for it -- so
    # "minimise thinking" is already the state of every call this file makes.
    # The parameter is answered by the Gemini translator, which has a default to
    # turn down. Requesting it on Claude would need a thinking block here, and
    # nothing in this service wants one.
    del thinking
    native = []
    for m in messages:
        if m["kind"] == "user_text":
            native.append({"role": "user", "content": m["text"]})
        elif m["kind"] == "raw":
            native.append({"role": "assistant", "content": m["value"]})
        elif m["kind"] == "tool_results":
            native.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": call.id, "content": text}
                for call, text in m["results"]
            ]})

    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": native,
    }
    if tools:
        kwargs["tools"] = tools
    if forced_tool:
        kwargs["tool_choice"] = {"type": "tool", "name": forced_tool}
    if temperature is not None:
        # THROUGH extra_body BECAUSE THE SDK NO LONGER TAKES IT. anthropic 1.x
        # removed temperature, top_p and top_k from messages.create() -- passing
        # one is a TypeError raised before any request. extra_body is merged
        # into the request JSON as-is, which is how a parameter the API still
        # honours reaches it after the client stopped declaring it.
        #
        # THE CALLER IS RESPONSIBLE FOR WHETHER THE MODEL ACCEPTS IT. Claude
        # Sonnet 5 rejects any non-default sampling value with a 400 and the
        # models after it reject even the default; Haiku 4.5 accepts them. This
        # layer passes on what it is given rather than second-guessing a model
        # id it does not recognise.
        kwargs["extra_body"] = {"temperature": temperature}

    response = client().messages.create(**kwargs)

    text = "".join(b.text for b in response.content if b.type == "text")
    calls = [
        ToolCall(name=b.name, args=dict(b.input), id=b.id)
        for b in response.content if b.type == "tool_use"
    ]
    # THE CONTENT LIST ITSELF is what goes back as the assistant turn, which is
    # what model_turn() will wrap. Anthropic has no thought signatures to lose,
    # but echoing the object rather than rebuilding it is the same rule.
    return Turn(text=text, tool_calls=calls, raw=response.content)


# ── GEMINI ──────────────────────────────────────────────────────────────────
def _generate_gemini(*, model, system, messages, tools, forced_tool,
                     max_tokens, temperature, thinking) -> Turn:
    from google.genai import types

    contents = []
    for m in messages:
        if m["kind"] == "user_text":
            contents.append(types.Content(
                role="user", parts=[types.Part(text=m["text"])]))
        elif m["kind"] == "raw":
            # VERBATIM, AND THIS IS THE THOUGHT-SIGNATURE RULE. Gemini 3 attaches
            # signatures to the parts of a turn that used thinking, and requires
            # them back on the next round of a tool loop. They survive only if
            # the model's own Content object is handed back untouched.
            contents.append(m["value"])
        elif m["kind"] == "tool_results":
            parts = []
            for call, text in m["results"]:
                # THE PAYLOAD IS A DICT, NOT A STRING, which is the difference
                # that would otherwise be found at runtime: Anthropic's
                # tool_result carries free text and Gemini's function response
                # carries a JSON object. The tools here return prose, so it is
                # wrapped under one key rather than invented into a schema.
                fr = types.FunctionResponse(
                    name=call.name, response={"result": text})
                # SENT ONLY WHEN THERE IS ONE. Gemini usually omits call ids and
                # matches on the name; passing an explicit None is not the same
                # as omitting the field.
                if call.id:
                    fr.id = call.id
                parts.append(types.Part(function_response=fr))
            contents.append(types.Content(role="user", parts=parts))

    config_kwargs = {
        "system_instruction": system,
        "max_output_tokens": max_tokens,
    }
    if temperature is not None:
        # Gemini takes this directly, unlike Anthropic 1.x. No extra_body.
        config_kwargs["temperature"] = temperature
    if not thinking:
        # A BUDGET OF ZERO IS A REQUEST FOR AS LITTLE AS POSSIBLE, not a switch:
        # measured at ~100 tokens of thought rather than none. That is still a
        # fifth of the ~490 an unbudgeted call spent, which is the difference
        # between /parse fitting inside its ceiling and not.
        config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    if tools:
        config_kwargs["tools"] = [types.Tool(function_declarations=[
            _gemini_declaration(types, t) for t in tools])]
        # OUR LOOP, NOT THE SDK'S. google-genai will run tools by itself when it
        # is handed Python callables; it is handed declarations here, so the
        # feature is dormant either way. Disabled explicitly so that stays true
        # if the declarations ever become callables.
        config_kwargs["automatic_function_calling"] = (
            types.AutomaticFunctionCallingConfig(disable=True))
    if forced_tool:
        # MODE "ANY" IS THE FORCING, and the allowed-names list is what narrows
        # it to one tool. Anthropic spells the same thing as a tool_choice
        # naming the tool.
        config_kwargs["tool_config"] = types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(
                mode="ANY", allowed_function_names=[forced_tool]))

    response = client().models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**config_kwargs),
    )

    # THE PARTS ARE READ BY HAND rather than through response.text, which
    # concatenates only text parts and warns when a response carries others --
    # and every tool round carries others.
    candidate = (response.candidates or [None])[0]
    content = getattr(candidate, "content", None)
    parts = getattr(content, "parts", None) or []

    text = "".join(p.text for p in parts if getattr(p, "text", None)
                   and not getattr(p, "thought", False))
    calls = [
        ToolCall(name=p.function_call.name,
                 args=dict(p.function_call.args or {}),
                 id=getattr(p.function_call, "id", None))
        for p in parts if getattr(p, "function_call", None)
    ]
    return Turn(text=text, tool_calls=calls, raw=content)


def _gemini_declaration(types, tool: dict):
    """One Anthropic-shaped tool declaration, as Gemini wants it.

    parameters_json_schema TAKES THE SCHEMA UNCHANGED, which is why the tool
    definitions in api.py did not have to be rewritten: name, description and
    the JSON Schema map one to one.

    A TOOL WITH NO PARAMETERS DECLARES NO SCHEMA AT ALL. Gemini is stricter than
    Anthropic about an object schema with an empty properties map, and the
    honest translation of "this tool takes nothing" is an absent parameter list
    rather than an empty one. find_flight_from_gmail is the tool this is for.
    """
    schema = tool.get("input_schema") or {}
    kwargs = {"name": tool["name"], "description": tool.get("description", "")}
    if schema.get("properties"):
        kwargs["parameters_json_schema"] = schema
    return types.FunctionDeclaration(**kwargs)


# ──────────────────────────────────────────────
# WHAT WENT WRONG, IN FOUR WORDS
# ──────────────────────────────────────────────
def _looks_like_billing(exc: Exception) -> bool:
    """Is this failure "the account has run out of money"?

    SUBSTRING MATCHING, AND THERE IS NO ALTERNATIVE. Neither provider gives
    billing exhaustion a class, a code or a status of its own:

      Anthropic  400 invalid_request_error, "your credit balance is too low"
                 -- the same 400 a malformed request gets.
      Gemini     429 RESOURCE_EXHAUSTED, "Your prepayment credits are depleted"
                 -- byte-identical in code and status to being rate limited.

    So the only thing carrying the distinction is the prose, and reading prose
    is fragile: a provider can reword it tomorrow and this silently stops
    matching. It is still worth doing, because of what the two mistakes cost.

    A FALSE POSITIVE COSTS ALMOST NOTHING. 'credit' and 'generic' produce the
    SAME user-facing string by design -- see CHAT_ERROR_CREDIT -- so a
    throughput failure misread as billing changes one word in a log line.

    A FALSE NEGATIVE COSTS HOURS. An account with no money left, reported as
    "busy, please try again in a moment", is advice that will never come true,
    aimed at a rate limit that is not the problem, while the operator reads
    quota dashboards. That asymmetry is why the match is deliberately loose:
    "credit" catches Anthropic's "credit balance" and Gemini's "prepayment
    credits" both, and nothing else here says the word.
    """
    return "credit" in str(exc).lower()


def failure_kind(exc: Exception) -> tuple[str, str]:
    """Classify a failed model call. Returns (kind, reason-for-the-log).

    KIND IS ONE OF 'config', 'busy', 'credit', 'generic', and the caller turns
    it into words. That split is deliberate and predates this file: what went
    wrong is provider knowledge and belongs here; what to SAY about it is a fact
    about the screen the failure will appear on and belongs to the endpoint.

    IT CLASSIFIES FROM THE EXCEPTION, NEVER FROM PROVIDER. The exception knows
    which SDK raised it, which stays true if the configuration and reality ever
    disagree -- a stale environment variable, a switch mid-deploy, a client
    built before a change.

    THE TWO SDKS ARE SHAPED DIFFERENTLY AND THAT IS THE WHOLE DIFFICULTY.
    Anthropic raises a class per failure -- AuthenticationError,
    PermissionDeniedError, RateLimitError, BadRequestError. Google raises
    APIError with ClientError and ServerError beneath it and NOTHING more
    granular, so the status code carries what the class carries there.

    'credit' FIRES ON EVERY PROVIDER, and an earlier version of this file said
    it could not. See _looks_like_billing for what corrected that and why it
    matters more than the tidiness it costs.
    """
    # -- Anthropic, which is also Vertex --
    if isinstance(exc, anthropic.AuthenticationError):
        return "config", "authentication rejected"
    if isinstance(exc, anthropic.PermissionDeniedError):
        return "config", "permission denied"
    if isinstance(exc, anthropic.RateLimitError):
        return "busy", "rate limited"
    if isinstance(exc, anthropic.BadRequestError):
        if _looks_like_billing(exc):
            return "credit", "credit balance exhausted"
        return "config", f"bad request ({type(exc).__name__})"

    # -- Gemini --
    #
    # IMPORTED INSIDE THE FUNCTION for the same reason the client is: a Claude
    # deployment should not need google-genai present to classify a Claude
    # error. A missing package here means no Gemini error can have been raised.
    try:
        from google.genai import errors as genai_errors
    except ImportError:
        genai_errors = None

    if genai_errors is not None and isinstance(exc, genai_errors.APIError):
        code = getattr(exc, "code", None)
        status = getattr(exc, "status", None) or ""
        if code in (401, 403):
            return "config", f"authentication or permission rejected ({status})"
        if code == 429:
            # RUNNING OUT OF MONEY AND GOING TOO FAST ARE THE SAME STATUS HERE,
            # and telling them apart is the whole reason the message is read.
            # Observed, not guessed: a depleted account returns 429
            # RESOURCE_EXHAUSTED with "Your prepayment credits are depleted",
            # byte-identical in code and status to ordinary throughput limiting.
            if _looks_like_billing(exc):
                return "credit", "prepaid credits depleted"
            return "busy", f"rate limited ({status})"
        if code is not None and 400 <= code < 500:
            return "config", f"rejected with {code} ({status})"
        return "generic", f"provider error {code} ({status})"

    return "generic", type(exc).__name__
