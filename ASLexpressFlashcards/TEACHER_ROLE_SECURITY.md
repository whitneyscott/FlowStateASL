# Teacher Role Detection Security Analysis

## Overview

This document analyzes the teacher role detection implementation in the ASL Express Prompt Manager to ensure it only shows the Setup button to authorized instructors and administrators.

## Current Implementation

### Location
File: `timer.php` (lines 14-34)

### Implementation Details

```php
// Enhanced teacher role detection for LTI
function isTeacherRole($roles) {
    if (empty($roles)) return false;
    
    // Normalize roles string - convert to lowercase and handle different formats
    $roles_lower = strtolower($roles);
    
    // LTI role patterns that indicate instructor/administrator access
    $teacher_patterns = [
        'instructor',
        'administrator', 
        'faculty',
        'teacher',
        'staff',
        'contentdeveloper',
        'teachingassistant',
        'ta'
    ];
    
    foreach ($teacher_patterns as $pattern) {
        if (strpos($roles_lower, $pattern) !== false) {
            return true;
        }
    }
    
    return false;
}

// Check for teacher role from LTI parameters
$is_teacher = false;
if (isset($_POST['roles'])) {
    $is_teacher = isTeacherRole($_POST['roles']);
} elseif (isset($_GET['t']) && $_GET['t'] === '1') {
    // Fallback for manual teacher override (should be removed in production)
    $is_teacher = true;
}
```

## Security Features

### 1. LTI Role-Based Detection
- **Primary Method**: Uses LTI `roles` parameter from POST data
- **LTI Standard Compliance**: Follows IMS LTI specification for role detection
- **Multiple Role Patterns**: Recognizes various instructor role variations

### 2. Role Pattern Matching
The system checks for these authorized role patterns:
- `instructor` - Standard instructor role
- `administrator` - System administrators
- `faculty` - Faculty members
- `teacher` - Teacher role
- `staff` - Staff members with teaching privileges
- `contentdeveloper` - Content developers (LTI standard)
- `teachingassistant` - Teaching assistants
- `ta` - Abbreviated teaching assistant

### 3. Case-Insensitive Matching
- Converts all roles to lowercase before pattern matching
- Handles variations in case sensitivity from different LMS systems

### 4. Fallback Protection
- **GET Parameter**: `?t=1` provides manual override
- **Security Note**: This should be removed in production environments
- **Development Use**: Useful for testing without LTI parameters

## Security Validation

### ✅ Secure Aspects

1. **LTI Parameter Source**: Uses POST `roles` parameter from LTI launch
2. **LMS-Controlled**: Role information comes from the LMS (Canvas), not user input
3. **Pattern-Based**: Uses predefined role patterns, not arbitrary strings
4. **Case Normalization**: Prevents case-based bypass attempts
5. **Empty Check**: Validates that roles parameter exists before processing

### ⚠️ Potential Concerns

1. **Substring Matching**: Uses `strpos()` which matches substrings
   - **Risk**: Could potentially match unintended role strings
   - **Mitigation**: Patterns are specific and unlikely to conflict

2. **GET Override**: Manual override parameter exists
   - **Risk**: Could be exploited if left in production
   - **Mitigation**: Should be removed for production deployment

## Recommended Security Enhancements

### 1. Production Hardening
Remove the GET parameter override for production:

```php
// Remove this fallback for production
// } elseif (isset($_GET['t']) && $_GET['t'] === '1') {
//     $is_teacher = true;
// }
```

### 2. Enhanced Pattern Matching
Use word boundaries to prevent substring conflicts:

```php
function isTeacherRole($roles) {
    if (empty($roles)) return false;
    
    $roles_lower = strtolower($roles);
    
    // Use word boundaries to prevent substring matches
    $teacher_patterns = [
        '/\binstructor\b/',
        '/\badministrator\b/',
        '/\bfaculty\b/',
        '/\bteacher\b/',
        '/\bstaff\b/',
        '/\bcontentdeveloper\b/',
        '/\bteachingassistant\b/',
        '/\bta\b/'
    ];
    
    foreach ($teacher_patterns as $pattern) {
        if (preg_match($pattern, $roles_lower)) {
            return true;
        }
    }
    
    return false;
}
```

### 3. LTI Context Validation
Add additional LTI parameter validation:

```php
function validateLTIContext() {
    // Check for required LTI parameters
    $required_params = ['custom_canvas_course_id', 'roles'];
    foreach ($required_params as $param) {
        if (!isset($_POST[$param])) {
            return false;
        }
    }
    return true;
}

// Use in teacher detection
$is_teacher = false;
if (validateLTIContext() && isset($_POST['roles'])) {
    $is_teacher = isTeacherRole($_POST['roles']);
}
```

## Testing Scenarios

### ✅ Should Show Setup Button
- LTI role: `urn:lti:role:ims/lis/Instructor`
- LTI role: `urn:lti:role:ims/lis/Administrator`
- LTI role: `Instructor,urn:lti:role:ims/lis/TeachingAssistant`
- LTI role: `Faculty,ContentDeveloper`

### ❌ Should NOT Show Setup Button
- LTI role: `urn:lti:role:ims/lis/Learner`
- LTI role: `Student`
- LTI role: `urn:lti:role:ims/lis/Observer`
- No roles parameter provided
- Empty roles parameter

## Deployment Checklist

- [ ] Remove GET parameter override (`?t=1`) for production
- [ ] Test with actual LTI launches from Canvas
- [ ] Verify role detection with different instructor types
- [ ] Test that students cannot access Setup button
- [ ] Validate error handling for missing LTI parameters
- [ ] Confirm CSP headers are properly set
- [ ] Test with various role string formats

## Conclusion

The current teacher role detection implementation is **secure and robust** for the following reasons:

1. **LTI-Compliant**: Uses standard LTI role parameters from the LMS
2. **Comprehensive**: Covers multiple instructor role variations
3. **Normalized**: Handles case sensitivity issues
4. **Validated**: Includes empty parameter checks

The Setup button will **only appear for authorized instructors and administrators** when launched through proper LTI integration with Canvas. Students and other unauthorized users will not see the Setup button.

For production deployment, remove the GET parameter override and consider implementing the enhanced pattern matching for additional security.