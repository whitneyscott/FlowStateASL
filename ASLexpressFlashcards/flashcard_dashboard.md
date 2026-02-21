# Technical Feasibility Study: Flashcard Dashboard Architecture

## Executive Summary

This document presents a technical feasibility study and logic blueprint for implementing a curriculum-agnostic "Hub & Link" model that supports multiple video repositories and proactive teacher setup guidance. The proposed architecture will enable dual navigation (central dashboard + deep links) and provide teachers with a comprehensive command center for configuration and content management.

## Current System Analysis

### Existing Architecture Strengths
- **LTI Integration**: Robust LTI 1.1 implementation with proper role detection (Migrating to LTI 1.3)
- **API Bridges**: Well-structured Canvas and SproutVideo API integration
- **Security Model**: Teacher role detection using LTI parameters with fallback protection
- **Data Persistence**: SQLite database for prompt configurations with course/assignment keys (Upcoming: LTI 1.3)
- **Content Discovery**: Smart playlist matching with multiple format support

### Current Limitations
- **Single Navigation**: No central dashboard for course overview
- **Limited Teacher Control**: No BYOC (Bring Your Own Content) support
- **Static Content Mapping**: No manual playlist-to-module mapping
- **No Setup Wizard**: No guided configuration for new courses
- **Data Storage**: Current SQLite implementation will migrate to LTI 1.3 data storage

### LTI 1.3 Migration Strategy
- **Data Storage**: Transition from SQLite to LTI 1.3 Tool Data Storage API
- **Security**: Enhanced OAuth 2.0 authentication and JWT-based security
- **Scopes**: Implement required LTI 1.3 scopes for data persistence
- **Backward Compatibility**: Maintain LTI 1.1 support during transition period

## Proposed Architecture: Hub & Link Model

### Core Components

#### 1. Flashcard Dashboard (Central Hub)
- **Entry Point**: New LTI tool "ASLExpress Dashboard"
- **Navigation**: Appears in Canvas Course Navigation
- **Functionality**: Course overview, configuration management, deep link generation

#### 2. Deep Link System
- **Integration**: Injected into existing Canvas modules
- **Trigger**: Teacher-configured module-to-playlist mappings
- **Behavior**: Opens specific flashcard decks within module context

#### 3. Teacher Command Center
- **Access Control**: Teacher-only UI with LTI role validation
- **Configuration**: BYOC token management and content mapping
- **Validation**: Course state detection and setup guidance

## Technical Implementation Plan

### 1. Course State Detection Logic

```php
// New function in dashboard.php
function getCourseState($course_id) {
    // Check for existing configuration
    $config = loadCourseConfig($course_id);
    
    if (!$config) {
        return 'NEW_COURSE'; // No saved mappings or tokens
    }
    
    if (!$config['sprout_token'] || !$config['mappings']) {
        return 'INCOMPLETE_SETUP'; // Partial configuration
    }
    
    return 'CONFIGURED'; // Full setup complete
}

// Database schema for course configuration
CREATE TABLE course_configs (
    course_id TEXT PRIMARY KEY,
    sprout_token TEXT,
    mappings TEXT, -- JSON array of module_id -> playlist_id mappings
    created_at INTEGER,
    updated_at INTEGER
);
```

### 2. Data Schema for BYOC and Mapping

```sql
-- Enhanced course configuration table
CREATE TABLE course_configs (
    course_id TEXT PRIMARY KEY,
    sprout_token TEXT NOT NULL, -- BYOC API token
    mappings TEXT, -- JSON: {"module_123": "playlist_abc", "module_456": "playlist_def"}
    manual_overrides TEXT, -- JSON: {"module_789": {"playlist_id": "custom_xyz", "notes": "Custom content"}}
    created_at INTEGER,
    updated_at INTEGER
);

-- Audit trail for configuration changes
CREATE TABLE config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id TEXT,
    action TEXT, -- 'token_saved', 'mapping_added', 'mapping_removed'
    details TEXT, -- JSON with before/after state
    changed_by TEXT, -- Teacher user ID from LTI
    changed_at INTEGER
);
```

### 3. Select-Validate-Map Workflow

#### Phase 1: Canvas Module Discovery
```php
function scanCanvasModules($course_id, $canvas_token, $canvas_domain) {
    $modules = [];
    $url = "https://{$canvas_domain}/api/v1/courses/{$course_id}/modules";
    
    // Paginated API call to get all modules
    $response = curl_get($url, ['Authorization: Bearer ' . $canvas_token]);
    $data = json_decode($response, true);
    
    foreach ($data as $module) {
        $modules[] = [
            'id' => $module['id'],
            'name' => $module['name'],
            'position' => $module['position'],
            'has_content' => !empty($module['items_count'])
        ];
    }
    
    return $modules;
}
```

#### Phase 2: SproutVideo Playlist Matching
```php
function findMatchingPlaylists($filter, $sprout_token) {
    $playlists = fetchAllPlaylists($sprout_token);
    $matches = [];
    
    foreach ($playlists as $playlist) {
        $smart_versions = getSmartVersions($filter);
        
        foreach ($smart_versions as $version) {
            if (stripos($playlist['title'], $version) === 0) {
                $matches[] = [
                    'id' => $playlist['id'],
                    'title' => $playlist['title'],
                    'match_type' => 'exact',
                    'confidence' => 100
                ];
                break;
            }
        }
    }
    
    return $matches;
}
```

#### Phase 3: Teacher Validation Interface
```javascript
// Frontend validation logic
function validateMapping(module, playlist) {
    const validation = {
        module_name: module.name,
        playlist_title: playlist.title,
        confidence: calculateConfidence(module.name, playlist.title),
        warnings: [],
        suggestions: []
    };
    
    // Check for potential mismatches
    if (validation.confidence < 80) {
        validation.warnings.push('Low confidence match - please review');
    }
    
    // Suggest alternatives
    const alternatives = findAlternativePlaylists(module.name);
    if (alternatives.length > 0) {
        validation.suggestions = alternatives.slice(0, 3);
    }
    
    return validation;
}
```

### 4. Security Implementation

#### LTI Role Validation Enhancement
```php
function validateTeacherAccess($lti_roles, $course_id) {
    // Enhanced role detection with Canvas API verification
    if (!isTeacherRole($lti_roles)) {
        return false;
    }
    
    // Additional Canvas API check for course permissions
    $canvas_token = getCanvasTokenForCourse($course_id);
    $user_id = $_POST['custom_canvas_user_id'] ?? null;
    
    if ($user_id && $canvas_token) {
        $permissions = checkCanvasPermissions($user_id, $course_id, $canvas_token);
        return $permissions['can_manage_content'];
    }
    
    return true; // Fallback to LTI role detection
}
```

#### BYOC Token Security
```php
function validateSproutToken($token) {
    // Test token with SproutVideo API
    $test_url = 'https://api.sproutvideo.com/v1/playlists?per_page=1';
    $headers = ['SproutVideo-Api-Key: ' . $token];
    
    $response = curl_get($test_url, $headers);
    $data = json_decode($response, true);
    
    if (isset($data['error'])) {
        return ['valid' => false, 'error' => $data['error']];
    }
    
    return ['valid' => true, 'usage' => count($data['playlists'])];
}
```

## Implementation Phases

### Phase 1: Core Dashboard Infrastructure
- [ ] Create dashboard.php LTI entry point
- [ ] Implement course state detection logic
- [ ] Build basic dashboard UI with teacher role validation
- [ ] Create LTI 1.3 data storage integration (replacing SQLite)

### Phase 2: LTI 1.3 Migration & BYOC Token Management
- [ ] Implement LTI 1.3 Tool Data Storage API integration
- [ ] Add OAuth 2.0 authentication and JWT security
- [ ] Add token validation and storage functionality
- [ ] Implement secure token encryption/decryption
- [ ] Create teacher UI for token configuration
- [ ] Add audit logging for token changes

### Phase 3: Content Mapping System
- [ ] Implement Canvas module scanning
- [ ] Build playlist discovery and matching
- [ ] Create mapping validation interface
- [ ] Add manual override capabilities

### Phase 4: Deep Link Integration
- [ ] Modify existing flashcards.php for deep link support
- [ ] Implement module-specific playlist loading
- [ ] Add deep link generation in dashboard
- [ ] Create seamless navigation between dashboard and modules

### Phase 5: Setup Wizard & Validation
- [ ] Build guided setup workflow
- [ ] Implement course state detection on launch
- [ ] Create validation feedback system
- [ ] Add progress tracking and completion indicators
- [ ] Implement LTI 1.1 backward compatibility layer

## Technical Risks & Mitigation

### Risk 1: Canvas API Rate Limiting
- **Mitigation**: Implement caching for module lists, use pagination efficiently
- **Fallback**: Cache module data locally with timestamp validation

### Risk 2: SproutVideo API Changes
- **Mitigation**: Abstract API calls through bridge layer, implement version detection
- **Fallback**: Graceful degradation with cached playlist data

### Risk 3: LTI Role Spoofing
- **Mitigation**: Enhanced validation with Canvas API permission checks
- **Fallback**: Maintain existing LTI role detection as backup

### Risk 4: Database Schema Conflicts
- **Mitigation**: Use separate namespace for new tables, implement migration scripts
- **Fallback**: Maintain backward compatibility with existing SQLite structure

## Performance Considerations

### API Call Optimization
- Cache Canvas module lists for 15 minutes
- Cache SproutVideo playlist data for 10 minutes
- Implement lazy loading for large playlist collections

### Database Performance
- Index course_id and assignment_id columns
- Use JSON columns for flexible configuration storage
- Implement cleanup jobs for old audit records

### Frontend Performance
- Lazy load dashboard components
- Implement virtualization for long playlist lists
- Use efficient state management for mapping UI

## Security Architecture

### Data Protection
- Encrypt BYOC tokens using AES-256 with course-specific keys
- Hash sensitive configuration data before storage
- Implement secure session management for teacher workflows

### Access Control
- Validate LTI signatures for all dashboard requests
- Implement course-level permission checks
- Log all configuration changes with user attribution

### Input Validation
- Sanitize all Canvas API responses
- Validate SproutVideo API responses
- Implement CSRF protection for configuration forms

## Integration Points

### Existing System Integration
- Reuse existing canvas_bridge.php for module discovery
- Extend sprout_bridge.php for BYOC token support
- Maintain compatibility with existing LTI launch flows

### New System Components
- dashboard.php: Main dashboard entry point
- config_manager.php: Configuration storage and validation
- mapping_engine.php: Content mapping logic
- setup_wizard.php: Guided configuration workflow

## Success Metrics

### Technical Metrics
- Dashboard load time: < 3 seconds
- API response time: < 1 second for 95% of requests
- Configuration save time: < 500ms
- Error rate: < 1% for API operations

### User Experience Metrics
- Setup completion rate: > 80% for new courses
- Teacher satisfaction: > 4.0/5.0 for configuration workflow
- Deep link usage: > 60% of configured modules
- Support tickets: < 5% reduction in configuration-related issues

## Conclusion

The proposed Hub & Link architecture is technically feasible and builds upon the existing robust foundation. The implementation plan provides a clear path forward with appropriate security measures, performance optimizations, and integration strategies. The phased approach allows for incremental deployment and validation of each component.

Key technical advantages:
- Leverages existing LTI and API infrastructure
- Implements comprehensive security measures
- Provides flexible content mapping capabilities
- Maintains backward compatibility with current system
- Supports multiple video repository integration

The architecture successfully addresses the vision requirements while maintaining the system's reliability and security standards.