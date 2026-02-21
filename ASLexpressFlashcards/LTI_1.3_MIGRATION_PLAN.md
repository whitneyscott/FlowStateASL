# ASL Express: LTI 1.3 Migration & Enhancement Plan

> **Living Document** - Update this plan as development progresses and requirements evolve

---

## 🎯 Project Goals

**Primary Objective**: Migrate ASL Express from LTI 1.1 to LTI 1.3 Advantage, maintaining two separate tools (Flashcards + Timed Practice) with a unified launch point where teachers configure tool type via Deep Linking.

**Current State**:
- Two working LTI 1.1 tools with basic OAuth (no signature validation)
- SproutVideo integration for video content
- SQLite database for prompt configurations
- Basic Canvas API integration for grades

**Target State**:
- LTI 1.3 with proper OIDC/JWT security
- Deep Linking for teacher tool configuration
- Enhanced Assignment and Grade Services (AGS)
- QTI/Item Bank integration for timed prompts only
- Unified component architecture

---

## 📋 Phase 1: LTI 1.3 Foundation (PRIORITY)

### 1.1 Project Setup & Structure

- [ ] **Create LTI 1.3 directory structure**
  ```
  lti/
  ├── config/
  │   ├── platform-config.json    # Canvas platform registration
  │   ├── tool-config.php          # Tool constants
  │   ├── private-key.pem          # RSA private key (gitignored)
  │   └── public-key.pem           # RSA public key
  ├── services/
  │   ├── JWTValidator.php         # JWT signature validation
  │   ├── OIDCLogin.php            # OIDC login handler
  │   ├── PlatformRegistry.php     # Platform management
  │   └── DeepLinking.php          # Deep Linking service
  └── handlers/
      ├── oidc-login.php           # OIDC login endpoint
      ├── oidc-redirect.php        # OIDC redirect/launch endpoint
      ├── deep-link.php            # Deep Linking picker UI
      └── deep-link-submit.php     # Deep Linking response
  ```

- [ ] **Generate RSA key pair for JWT signing**
  ```bash
  openssl genrsa -out lti/config/private-key.pem 2048
  openssl rsa -in lti/config/private-key.pem -pubout -out lti/config/public-key.pem
  chmod 600 lti/config/private-key.pem
  ```

- [ ] **Create JWKS endpoint** (`lti/jwks.json`)
  - Convert public key to JWK format: https://russelldavies.github.io/jwk-creator/
  - Expose as public endpoint for Canvas to fetch

- [ ] **Update `.env` with LTI 1.3 configuration**
  ```env
  # LTI 1.3 Configuration
  LTI_VERSION=1.3
  LTI_OIDC_LOGIN_URL=https://aslexpress.net/SproutCanvas/dev/lti/handlers/oidc-login.php
  LTI_REDIRECT_URL=https://aslexpress.net/SproutCanvas/dev/lti/handlers/oidc-redirect.php
  LTI_JWKS_URL=https://aslexpress.net/SproutCanvas/dev/lti/jwks.json

  # Canvas Platform
  CANVAS_ISSUER=https://canvas.instructure.com
  CANVAS_AUTH_URL=https://tjc.instructure.com/api/lti/authorize_redirect
  CANVAS_TOKEN_URL=https://tjc.instructure.com/login/oauth2/token
  CANVAS_JWKS_URL=https://tjc.instructure.com/api/lti/security/jwks
  CANVAS_CLIENT_ID=<from Canvas Developer Keys>
  CANVAS_DEPLOYMENT_ID=<from Canvas after installation>
  ```

- [ ] **Add `.gitignore` entries**
  ```
  lti/config/private-key.pem
  lti/config/public-key.pem
  .env
  ```

### 1.2 OIDC Login Flow Implementation

- [ ] **Create `PlatformRegistry.php`**
  - Load platform configurations from `platform-config.json`
  - Provide lookup by issuer URL
  - Support multiple Canvas instances

- [ ] **Create `platform-config.json`**
  ```json
  [
    {
      "name": "TJC Canvas Production",
      "issuer": "https://canvas.instructure.com",
      "client_id": "<from Canvas Developer Keys>",
      "deployment_id": "<from Canvas>",
      "auth_url": "https://tjc.instructure.com/api/lti/authorize_redirect",
      "token_url": "https://tjc.instructure.com/login/oauth2/token",
      "jwks_url": "https://tjc.instructure.com/api/lti/security/jwks",
      "redirect_uri": "https://aslexpress.net/SproutCanvas/dev/lti/handlers/oidc-redirect.php"
    }
  ]
  ```

- [ ] **Create `oidc-login.php`** (Login Initiation)
  - Accept: `iss`, `login_hint`, `target_link_uri`, `lti_message_hint`
  - Generate: `state` (CSRF protection), `nonce` (replay protection)
  - Store state/nonce in session with 5-minute TTL
  - Redirect to Canvas authorization endpoint

- [ ] **Create `oidc-redirect.php`** (Authentication & Launch)
  - Validate: `state` matches session
  - Extract: `id_token` from POST
  - Validate JWT using `JWTValidator`
  - Extract LTI context (user, roles, custom parameters)
  - Store LTI context in session
  - Route to appropriate tool based on `tool_type` custom parameter
  - Handle Deep Linking vs Resource Launch message types

### 1.3 JWT Validation Service

- [ ] **Create `JWTValidator.php`**
  - Decode JWT header and payload
  - Validate issuer against platform config
  - Validate nonce matches expected value
  - Validate expiration (`exp` claim)
  - Validate audience (`aud` matches `client_id`)
  - Fetch Canvas public keys from JWKs endpoint
  - Cache JWKs for 1 hour (performance optimization)
  - Verify JWT signature using Canvas public key
  - Validate required LTI 1.3 claims
  - Return claims array on success, false on failure

- [ ] **Consider using JWT library** (recommended)
  - Option 1: `firebase/php-jwt` (industry standard)
  - Option 2: `web-token/jwt-framework` (comprehensive)
  - Install via Composer: `composer require firebase/php-jwt`

### 1.4 Deep Linking Implementation

- [ ] **Create `deep-link.php`** (Picker UI)
  - Display two tool options:
    - 📚 Flashcards (practice modes, SproutVideo content)
    - ⏱️ Timed Practice (recording, prompts)
  - Store teacher selection in form
  - Submit to `deep-link-submit.php`

- [ ] **Create `deep-link-submit.php`** (Response Handler)
  - Validate Deep Linking session
  - Build content item based on tool type
  - Set custom parameters:
    - `tool_type` = 'flashcards' or 'timer'
    - Canvas substitution variables ($Canvas.course.id, etc.)
  - Generate Deep Linking response JWT
  - Auto-submit form back to Canvas

- [ ] **Create `DeepLinking.php`** service
  - Create Deep Linking response JWT
  - Sign with tool private key
  - Include content items array
  - Return URL and metadata for Canvas

### 1.5 Role Detection Update

- [ ] **Update `isTeacherRole()` in `canvas_bridge.php`**
  - Support LTI 1.3 role format (array of URIs)
  - Support LTI 1.1 role format (comma-separated string) during transition
  - LTI 1.3 patterns:
    - `http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor`
    - `http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator`
    - `http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper`
  - Remove `?t=1` manual override in production

- [ ] **Update role detection in `timer.php`**
  - Check `$_SESSION['lti_context']['roles']` first (LTI 1.3)
  - Fallback to `$_POST['custom_roles']` (LTI 1.1 legacy)

- [ ] **Update role detection in `flashcards.php`**
  - Same dual-format support as `timer.php`

### 1.6 Canvas Developer Key Configuration

- [ ] **Create Canvas LTI 1.3 Developer Key**
  - Navigate to: Admin → Developer Keys → + LTI Key
  - Configure placements:
    - ✅ Course Navigation (launch point)
    - ✅ Link Selection (Deep Linking)
  - Enable LTI Advantage Services:
    - Assignment and Grade Services (AGS)
    - Names and Role Provisioning Services (NRPS)
  - Set custom fields:
    ```
    course_id=$Canvas.course.id
    module_id=$Canvas.module.id
    assignment_id=$Canvas.assignment.id
    ```
  - Copy `client_id` and save to `platform-config.json`

- [ ] **Install tool in test course**
  - Settings → Apps → Find "ASL Express"
  - Add app
  - Copy `deployment_id` to `platform-config.json`

### 1.7 Security Enhancements

- [ ] **Remove security vulnerabilities**
  - Remove `?t=1` manual teacher override
  - Remove hardcoded Cohere API key from `ai_proxy.php`
  - Ensure all API keys load from `.env`

- [ ] **Enhanced CSP headers**
  ```php
  header("Content-Security-Policy: " .
         "default-src 'self'; " .
         "script-src 'self' 'unsafe-inline' https://cdn.quilljs.com; " .
         "style-src 'self' 'unsafe-inline' https://cdn.quilljs.com; " .
         "img-src 'self' data: https:; " .
         "media-src 'self' https://*.sproutvideo.com; " .
         "frame-ancestors 'self' https://*.instructure.com; " .
         "connect-src 'self' https://api.sproutvideo.com https://*.instructure.com;");
  ```

- [ ] **Session security**
  - Set secure session settings
  - Consider database-backed sessions for scale

### 1.8 Testing & Validation

- [ ] **Unit tests for JWT validation**
  - Valid JWT with correct signature
  - Expired JWT (should fail)
  - Invalid signature (should fail)
  - Missing nonce (should fail)
  - Wrong audience (should fail)

- [ ] **Integration tests for OIDC flow**
  - Login initiation from Canvas
  - State generation and storage
  - Redirect to Canvas auth endpoint
  - Canvas callback with valid JWT
  - Session creation
  - Redirect to resource

- [ ] **Manual testing checklist**
  - [ ] Launch Flashcards from Course Navigation
  - [ ] Launch Timed Practice from Course Navigation
  - [ ] Teacher role detection works
  - [ ] Student role (no setup button)
  - [ ] Deep Linking picker displays
  - [ ] Select Flashcards → verify launch
  - [ ] Select Timed Practice → verify launch
  - [ ] SproutVideo content loads
  - [ ] Video recording works
  - [ ] Prompt configuration persists

### 1.9 Migration Strategy

- [ ] **Week 1-2: Parallel deployment**
  - Deploy LTI 1.3 alongside existing LTI 1.1
  - Keep `lti_launch.php` and `lti_timed_launch.php` functioning
  - Test in sandbox course

- [ ] **Week 3-4: Pilot rollout**
  - Install in 2-3 pilot courses
  - Monitor for issues
  - Collect teacher feedback

- [ ] **Week 5: Full cutover**
  - Update all courses to LTI 1.3
  - Deprecate LTI 1.1 (keep as fallback)

- [ ] **Week 6: Cleanup**
  - Remove LTI 1.1 files
  - Remove backward compatibility code
  - Update documentation

---

## 📋 Phase 2: Data SSoT Pipelines (QTI & Item Banks)

> **Note**: Item Banks are ONLY for timed prompts. Flashcards will continue using SproutVideo.

### 2.1 QTI Generator

- [ ] **Create `QTIGenerator.php`**
  - Convert text prompts to QTI 1.2 XML format
  - Generate manifest file (imsmanifest.xml)
  - Create ZIP package for Canvas import
  - Support question types:
    - Essay (for video recording prompts)
    - Text entry (for typed responses)

- [ ] **Define QTI template structure**
  ```xml
  <assessment>
    <section>
      <item type="essay">
        <presentation>
          <material>Prompt text here</material>
        </presentation>
      </item>
    </section>
  </assessment>
  ```

### 2.2 Item Bank Porter

- [ ] **Create `ItemBankService.php`**
  - Use Canvas API to push QTI ZIP to Item Bank
  - Endpoint: `POST /api/v1/courses/:course_id/quizzes/item_banks/import`
  - Handle async import status polling
  - Return Item Bank ID on success

- [ ] **Migration utility for existing prompts**
  - Read prompts from SQLite database
  - Generate QTI for each prompt
  - Create Item Bank per course/module
  - Store Item Bank ID mapping

### 2.3 Bank Retrieval Logic

- [ ] **Create `ItemBankRetrieval.php`**
  - Real-time pull from Item Bank by ID
  - Endpoint: `GET /api/v1/item_banks/:id/items`
  - Parse QTI XML to extract prompt text
  - Cache results (5-minute TTL)

- [ ] **Update `timer.php` to use Item Banks**
  - Check for `item_bank_id` in custom parameters (from Deep Linking)
  - If present: fetch prompts from Item Bank
  - Else: fallback to SQLite database
  - Display prompts in warm-up phase

### 2.4 Deep Linking Metadata Storage

- [ ] **Update Deep Linking for Timed Practice**
  - Add Item Bank ID selection in picker UI
  - Store `item_bank_id` in content item custom parameters
  - Send in Deep Linking response
  - Retrieve on launch from JWT claims

---

## 📋 Phase 3: Unified Component UI

### 3.1 State Manager

- [ ] **Create `StateManager.js`**
  - Toggle between `Practice` and `Assessment` modes
  - Practice mode: Rehearsal/Tutorial/Screening (existing)
  - Assessment mode: Timed, graded, AGS submission
  - Persist mode in localStorage
  - Share across both tools

### 3.2 Recorder Component

- [ ] **Create `RecorderComponent.js`**
  - Extract WebRTC recording logic from `timer.php`
  - Conditional behavior:
    - Self-Check mode: Auto-download video
    - Server Upload mode: POST to Canvas/storage
  - Support audio-only recording option
  - Error handling for camera/mic permissions

### 3.3 Adaptive Timer Component

- [ ] **Create `AdaptiveTimer.js`**
  - Looped Practice mode: Repeating countdown
  - Fixed Deadline mode: Single countdown (assessment)
  - Visual progress indicator
  - Audio/visual alerts at milestones

---

## 📋 Phase 4: Assessment & Portability

### 4.1 Assignment and Grade Services (AGS)

- [ ] **Create `AGSService.php`**
  - Implement LTI Advantage AGS endpoints
  - Create line items in Canvas gradebook
  - Submit scores with decimal precision (0-1 scale)
  - Support score comments and timestamps

- [ ] **Update `save_session.php` to use AGS**
  - Replace basic Canvas API grade submission
  - Use AGS for formal assessments
  - Maintain backward compatibility during transition

### 4.2 Custom Parameter Storage

- [ ] **Ensure portability for course copies**
  - Store `item_bank_id` in Deep Linking metadata
  - Store `playlist_id` in Deep Linking metadata
  - Test course copy scenario
  - Verify parameters persist after copy

### 4.3 Cleanup Automation

- [ ] **Create cleanup utility**
  - Identify temporary "Migration Quizzes" created during QTI import
  - Delete via Canvas API after Item Bank creation
  - Schedule as cron job (weekly)
  - Log cleanup actions for audit

---

## 🔍 Verification & Testing

### End-to-End Testing Scenarios

**Scenario 1: Flashcards Tool**
1. Teacher uses Deep Linking to add Flashcards to module
2. Student launches from module
3. OIDC flow completes successfully
4. SproutVideo content loads based on module filter
5. Student completes screening mode
6. Score submitted to Canvas gradebook

**Scenario 2: Timed Practice Tool**
1. Teacher uses Deep Linking to add Timed Practice
2. Teacher configures Item Bank with prompts
3. Student launches tool
4. Prompts load from Item Bank
5. Video recording captures performance
6. File downloads successfully
7. Optional: Score submitted via AGS

**Scenario 3: Course Copy**
1. Teacher copies course with ASL Express tools
2. Deep Linking metadata preserved
3. Item Bank IDs remain valid
4. SproutVideo playlists remain accessible
5. No reconfiguration needed

---

## 📚 Documentation Updates

- [ ] **Update `LTI_SETUP_GUIDE.md`**
  - Replace LTI 1.1 XML instructions
  - Add Canvas Developer Key setup
  - Document Deep Linking picker

- [ ] **Create `LTI_1.3_ARCHITECTURE.md`**
  - OIDC flow diagram
  - JWT validation process
  - Security features
  - Deep Linking workflow

- [ ] **Update `DEPLOYMENT_CHECKLIST.md`**
  - Add key generation steps
  - Add Canvas Developer Key configuration
  - Add JWKS endpoint verification

- [ ] **Create teacher training materials**
  - Video: How to use Deep Linking
  - Guide: Configuring Item Banks
  - FAQ: Common issues and solutions

---

## 🚨 Known Issues & Risks

### Security Risks
- **Private key exposure**: Add to `.gitignore`, restrict permissions (600)
- **JWKs endpoint spoofing**: Validate URL matches platform config, enforce HTTPS
- **Session hijacking**: Use secure session settings, HTTPS only

### Technical Challenges
- **JWT validation complexity**: Use established library (`firebase/php-jwt`)
- **Canvas JWKs reliability**: Implement 1-hour cache with fallback
- **Browser compatibility**: Test OIDC redirects in Chrome, Firefox, Safari, Edge

### Migration Risks
- **Teacher training**: Create video tutorials, provide direct support
- **Content disruption**: Parallel operation, gradual rollout
- **Rollback plan**: Keep LTI 1.1 as fallback during transition

---

## 📊 Success Criteria

### Functional Requirements
- ✅ Both tools launch via LTI 1.3
- ✅ Deep Linking allows tool configuration
- ✅ Role detection accurate (teacher/student)
- ✅ SproutVideo content loads
- ✅ Item Banks work for timed prompts
- ✅ Video recording functional
- ✅ Grades submit via AGS

### Security Requirements
- ✅ JWT signatures validated
- ✅ CSRF protection (state)
- ✅ Replay protection (nonce)
- ✅ No manual overrides in production
- ✅ API keys secure (.env)

### Performance Requirements
- ✅ Launch completes <3 seconds
- ✅ JWT validation <500ms
- ✅ JWKs cached (1 hour)

---

## 🎯 Next Immediate Actions

1. **Set up development environment** with required PHP extensions (OpenSSL, cURL, JSON)
2. **Generate RSA keys** for JWT signing
3. **Create LTI 1.3 directory structure**
4. **Create Canvas Developer Key** in sandbox
5. **Begin implementing `JWTValidator.php`** and `PlatformRegistry.php`

---

## 📝 Notes & Decisions

_(Use this section to track decisions, blockers, and learnings as you develop)_

**2025-01-31**: Initial plan created based on LTI 1.3 migration strategy. Priority is Phase 1 (LTI 1.3 Foundation). QTI/Item Banks will only be used for timed prompts, not flashcards.

---

## Critical Files to Modify

### New Files (Create)
1. `lti/services/JWTValidator.php` - JWT signature validation
2. `lti/handlers/oidc-redirect.php` - Main launch handler
3. `lti/handlers/deep-link.php` - Teacher configuration UI
4. `lti/config/platform-config.json` - Platform registration
5. `lti/services/PlatformRegistry.php` - Platform management

### Existing Files (Modify)
1. `canvas_bridge.php` - Update role detection for LTI 1.3
2. `timer.php` - Add LTI 1.3 session support
3. `flashcards.php` - Add LTI 1.3 session support
4. `.env` - Add LTI 1.3 configuration variables
5. `save_session.php` - Migrate to AGS (Phase 4)
