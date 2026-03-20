# LTI 1.1 Backward Compatibility

FlowStateASL supports both LTI 1.3 and LTI 1.1 on the **same launch URL**: `POST /api/lti/launch`.

## Flow Overview

- **LTI 1.3**: Canvas POSTs `id_token` + `state` → OAuth 1.0a verification skipped → JWT validated → session + redirect to OAuth or app.
- **LTI 1.1**: Canvas POSTs `oauth_consumer_key` + `oauth_signature` + form params → OAuth 1.0a verified → session + redirect directly to app (no OAuth2).

LTI 1.1 users cannot use Canvas OAuth2 (Developer Key flow). When they need a Canvas API token, they use the **manual token modal** instead of the OAuth button.

## Canvas LTI 1.1 Tool Configuration

### Launch URL

Use the same URL as LTI 1.3:

- Production: `https://flowstateasl.onrender.com/api/lti/launch`
- Local: `http://localhost:3000/api/lti/launch`

### Required Extension Fields

Canvas must send these so we can extract `courseId` and `canvasBaseUrl`:

| LTI 1.1 Param | Canvas Variable | Purpose |
|---------------|-----------------|---------|
| `custom_canvas_course_id` | `$Canvas.course.id` | Course ID |
| `custom_canvas_user_id` | `$Canvas.user.id` | User ID |
| `custom_canvas_api_base_url` | `$Canvas.api.baseUrl` | Canvas API base (e.g. `https://your-school.instructure.com`) |
| `tool_consumer_instance_url` | (auto) | Fallback for Canvas domain |
| `roles` / `custom_roles` | `$Canvas.membership.roles` | Role check |

### Tool Type (flashcards vs prompter)

- Default: `flashcards`
- To launch Prompter, add custom: `custom_tool_type` = `prompter` (or `tool_type` = `prompter`)

### Example XML (unified launch URL)

```xml
<blti:launch_url>https://flowstateasl.onrender.com/api/lti/launch</blti:launch_url>
<blti:secure_launch_url>https://flowstateasl.onrender.com/api/lti/launch</blti:secure_launch_url>
<blti:custom>
    <lticm:property name="custom_canvas_course_id">$Canvas.course.id</lticm:property>
    <lticm:property name="custom_canvas_user_id">$Canvas.user.id</lticm:property>
    <lticm:property name="custom_canvas_api_base_url">$Canvas.api.baseUrl</lticm:property>
    <lticm:property name="custom_roles">$Canvas.membership.roles</lticm:property>
    <lticm:property name="custom_tool_type">flashcards</lticm:property>
</blti:custom>
```

### Consumer Key and Shared Secret

1. In Canvas: Developer Keys or External Tool config → set **Consumer Key** and **Shared Secret**.
2. In FlowStateASL `.env`: set `LTI11_SHARED_SECRET` to the same value as the Shared Secret.

For multiple tools (different consumer keys):

```env
LTI11_SECRETS_JSON={"key1":"secret1","key2":"secret2"}
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `LTI11_SHARED_SECRET` | Shared secret (preferred) |
| `LTI_1_1_SHARED_SECRET` | Alternative name |
| `LTI1_SHARED_SECRET` | Alternative name |
| `LTI_SHARED_SECRET` | Fallback |
| `LTI11_SECRETS_JSON` | Optional: `{"consumer_key":"secret"}` for multiple tools |
| `APP_URL` | Base URL for launch URL reconstruction (e.g. `https://flowstateasl.onrender.com`) |

## Legacy Endpoints (backward compatibility)

These still work for existing Canvas configs:

- `POST /api/lti/launch/flashcards` → LTI 1.1 flashcards (no OAuth verification; deprecated)
- `POST /api/lti/launch/prompter` → LTI 1.1 prompter (no OAuth verification; deprecated)

**Recommendation**: Migrate to the unified `POST /api/lti/launch` and configure `LTI11_SHARED_SECRET` for signed launches.

## Testing Checklist

- [ ] LTI 1.3 launch still works (OIDC → launch → OAuth → app)
- [ ] LTI 1.1 launch from Canvas → lands on app with manual token modal (no OAuth overlay)
- [ ] Enter token manually after 1.1 launch → app loads with course context
- [ ] Visiting `/api/oauth/canvas` after 1.1 launch redirects back to app (no OAuth2)
- [ ] Invalid OAuth 1.0a signature or wrong secret → clear error, no crash
