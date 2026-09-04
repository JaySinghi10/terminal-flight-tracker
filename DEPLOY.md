# Deploying the flight tracker backend

The service is a FastAPI app on Cloud Run. It talks to three outside things:
AeroDataBox for flight data, Google Cloud Storage for the alerts watchlist, and
Claude for `/chat` and `/parse`.

Every command below uses these. Set them once in the shell you are working in
and the rest of this file is copy-pasteable as written.

```sh
PROJECT_ID=flight-tracker-496006
SERVICE=flight-tracker
REGION=asia-south1
```

The one value not written down here is the **service account email**, because it
depends on how the service was created. The next section finds it.

---

## Claude runs on Vertex AI

The service reaches Claude through **Google Vertex AI**, not through
`api.anthropic.com`. It bills to the GCP project and authenticates as the Cloud
Run service account. There is no API key.

`llm.py` owns this decision and nothing else in the codebase knows which
provider is in use.

### One-time project setup

Enable the API:

```sh
gcloud services enable aiplatform.googleapis.com --project "$PROJECT_ID"
```

The service runs as the **Compute Engine default service account**:

```
970706733452-compute@developer.gserviceaccount.com
```

That was read off the deployed service, and it is the same identity that already
reaches the alerts bucket. To re-check it after any redeploy:

```sh
gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --format='value(spec.template.spec.serviceAccountName)'
```

An empty result there means the default account is in use, which is this one —
`PROJECT_NUMBER-compute@developer.gserviceaccount.com`, and the project number
is `970706733452`.

Grant it permission to call Vertex. **Storage permissions are not enough** —
without this role the first Claude call fails with a 403 while `/flight` and
`/route` keep working, which is a confusing way to find out:

```sh
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:970706733452-compute@developer.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

That account is the project's default compute identity, so this grant is not
scoped to this service alone — anything else running as it in this project can
call Vertex too. Worth knowing rather than discovering; a dedicated service
account is the tighter arrangement if this project ever grows a second workload.

### Environment variables

| Variable | Required | Default | What it is |
|---|---|---|---|
| `LLM_PROVIDER` | no | `vertex` | `vertex` or `anthropic`. The rollback switch. |
| `VERTEX_PROJECT_ID` | **yes** | — | GCP project for the Vertex call. |
| `VERTEX_REGION` | no | `global` | Vertex region. `global` lets Google route it. |
| `CHAT_MODEL` | no | `claude-sonnet-5` | The model `/chat` uses. |
| `PARSE_MODEL` | no | `claude-haiku-4-5` | The model `/parse` uses. |

Set them:

```sh
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars \
LLM_PROVIDER=vertex,\
VERTEX_PROJECT_ID="$PROJECT_ID",\
VERTEX_REGION=global,\
CHAT_MODEL=claude-sonnet-5,\
PARSE_MODEL=claude-haiku-4-5
```

**`--update-env-vars`, never `--set-env-vars`.** `--set-env-vars` replaces the
service's entire environment, which would silently drop `RAPIDAPI_KEY` and
`ALERTS_BUCKET` and break flight lookups and alerts along with it.

### Why `VERTEX_PROJECT_ID` is required

The Anthropic SDK documents a fallback to the project on your credentials, and
in practice it does not reach it: the client builds the request URL — which
contains the project — before it performs the auth exchange that would discover
one. A client left to infer the project raises `RuntimeError` on its first call.
Set it explicitly.

### Why the region does not have to match Cloud Run

Cloud Run's region and Vertex's are independent. `global` is the recommended
setting and routes the request for you, so the service in `asia-south1` calls
Claude without anyone having to know which regions serve it. Pin a specific
region only for data residency, and then check Claude is actually served there.

### The model identifiers

Vertex takes **no vendor prefix** (unlike Bedrock, which prepends `anthropic.`).
A current model is the same bare string on both providers, so the defaults above
are correct either way.

A **pinned snapshot is not**: the date separator differs.

| | Anthropic direct | Vertex AI |
|---|---|---|
| Current | `claude-haiku-4-5` | `claude-haiku-4-5` |
| Pinned | `claude-haiku-4-5-20251001` | `claude-haiku-4-5@20251001` |

Read the exact string off the model card in Model Garden before pinning. Because
these are environment variables, a wrong one is a config change rather than a
deploy.

---

## Local development

Vertex uses Application Default Credentials, so authenticate once:

```sh
gcloud auth application-default login
gcloud config set project "$PROJECT_ID"
```

Then `VERTEX_PROJECT_ID` in `.env` is all `/chat` and `/parse` need. `.env` is
gitignored and must stay that way.

This is new: before the Vertex switch these two endpoints could not run locally
at all, because `.env` carries no `ANTHROPIC_API_KEY`.

---

## Rolling back to Anthropic direct

One variable and a key:

```sh
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars LLM_PROVIDER=anthropic,ANTHROPIC_API_KEY=sk-ant-...
```

Better, keep the key in Secret Manager rather than in the environment:

```sh
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars LLM_PROVIDER=anthropic \
  --update-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest
```

Nothing else changes. The request bodies, tool schemas and response parsing are
identical on both providers.

Once Vertex is proven, remove the key from the service:

```sh
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --remove-env-vars ANTHROPIC_API_KEY
```

---

## Deploy

```sh
gcloud run deploy "$SERVICE" --source . --region "$REGION" --project "$PROJECT_ID"
```

### Verifying it worked

A failed Claude call never returns the provider's own words — that is
deliberate, and it means the user-facing string will not tell you what broke.
The reason goes to the logs instead:

```sh
gcloud run services logs read "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --limit 50
```

| Log line | What it means |
|---|---|
| `authentication rejected` | ADC did not resolve, or the account cannot call Vertex |
| `permission denied` | the service account is missing `roles/aiplatform.user` |
| `bad request` | usually a model id Vertex does not recognise |
| `rate limited` | Vertex quota |

`/flight`, `/route` and `/quota` never call a model, so they keep working
through all of the above. A misconfiguration here does not take the service
down; it takes two endpoints down.

---

## The dependency pin

`requirements.txt` pins `anthropic[vertex]>=1,<2`.

- The `vertex` extra pulls in `google-auth`, which resolves ADC.
- The major is pinned because this was previously unpinned, and `anthropic` 1.x
  removed `temperature`, `top_p` and `top_k` from `messages.create()`. An
  unpinned build would have broken `/parse` on the next deploy for a reason
  found nowhere in the repository.

`/parse` still sends `temperature=0`, through `extra_body`, because that path
re-validates everything the model returns and has no use for variance. **Do not
add a sampling parameter to `/chat`** — Claude Sonnet 5 rejects non-default
values with a 400, and later models reject even the default. There is a comment
at that call site saying so.
