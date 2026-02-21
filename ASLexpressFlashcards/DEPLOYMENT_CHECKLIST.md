# ASL Express Deployment Checklist

## Migration to SproutCanvas/dev Folder

### Pre-Deployment Checklist

- [ ] Verify all required files are present in `SproutCanvas/dev/` folder
- [ ] Confirm `.env` file contains valid API keys
- [ ] Test file permissions and web server access
- [ ] Backup existing production files (if any)
- [ ] Verify SSL certificate is active for HTTPS

### Required Files in SproutCanvas/dev/

Core LTI Files:
- [ ] `lti_launch.php` - Flashcards LTI handler
- [ ] `lti_timed_launch.php` - Prompt Manager LTI handler

Application Files:
- [ ] `flashcards.php` - Flashcard interface
- [ ] `timer.php` - Prompt Manager interface

Bridge Files:
- [ ] `canvas_bridge.php` - Canvas API bridge
- [ ] `sprout_bridge.php` - SproutVideo API bridge

Configuration:
- [ ] `.env` - Environment configuration

Support Files:
- [ ] `ai_proxy.php` - AI service proxy
- [ ] `hf_proxy.php` - Hugging Face proxy
- [ ] `save_session.php` - Session scoring
- [ ] `test_timed_flow.php` - Diagnostic tool

### Testing Checklist

#### Basic Functionality Tests
- [ ] Access `https://yourdomain.com/SproutCanvas/dev/flashcards.php` directly
- [ ] Access `https://yourdomain.com/SproutCanvas/dev/timer.php` directly
- [ ] Test `https://yourdomain.com/SproutCanvas/dev/test_timed_flow.php` for diagnostics
- [ ] Verify `.env` file loading with bridge files

#### API Connectivity Tests
- [ ] Test Canvas API connectivity via `canvas_bridge.php`
- [ ] Test SproutVideo API connectivity via `sprout_bridge.php`
- [ ] Verify API keys are working correctly
- [ ] Check network connectivity to external services

#### LTI Integration Tests
- [ ] Test `lti_launch.php` with sample LTI parameters
- [ ] Test `lti_timed_launch.php` with sample LTI parameters
- [ ] Verify proper redirects to respective applications
- [ ] Test error handling for invalid parameters

### Canvas LTI Configuration

#### Tool 1: ASLExpress Flashcards
- [ ] Create new LTI tool in Canvas
- [ ] Set Launch URL: `https://yourdomain.com/SproutCanvas/dev/lti_launch.php`
- [ ] Configure course navigation placement as "Flashcards"
- [ ] Test tool launch from Canvas interface

#### Tool 2: ASLExpress Prompt Manager
- [ ] Create new LTI tool in Canvas
- [ ] Set Launch URL: `https://yourdomain.com/SproutCanvas/dev/lti_timed_launch.php`
- [ ] Configure course navigation placement as "Prompt Manager"
- [ ] Test tool launch from Canvas interface

### Post-Deployment Verification

#### Functional Testing
- [ ] Launch Flashcards tool from Canvas
- [ ] Verify correct content loading for different modules
- [ ] Test all three learning modes (Rehearsal, Tutorial, Screening)
- [ ] Launch Prompt Manager tool from Canvas
- [ ] Test warm-up timer functionality
- [ ] Test video recording and download

#### User Experience Testing
- [ ] Verify responsive design on mobile devices
- [ ] Test video playback in flashcards
- [ ] Verify timer countdown and recording workflow
- [ ] Test progress tracking and scoring
- [ ] Verify Canvas grade submission integration

#### Error Handling
- [ ] Test with invalid LTI parameters
- [ ] Test with missing API keys
- [ ] Verify graceful error messages
- [ ] Test network connectivity issues

### Security Verification

- [ ] Confirm HTTPS is enforced for all endpoints
- [ ] Verify CSP headers are properly set
- [ ] Check that `.env` file is not publicly accessible
- [ ] Verify input validation is working
- [ ] Test for common security vulnerabilities

### Performance Testing

- [ ] Test with multiple concurrent users
- [ ] Verify video loading performance
- [ ] Check API response times
- [ ] Monitor server resource usage

### Documentation Updates

- [ ] Update any existing documentation with new URLs
- [ ] Update support materials with new tool names
- [ ] Create user guides for both tools
- [ ] Document troubleshooting procedures

### Rollback Plan

- [ ] Document steps to revert to previous version if needed
- [ ] Keep backup of previous configuration
- [ ] Test rollback procedure in development environment

## Notes

- Replace `yourdomain.com` with your actual domain
- Ensure all file paths are correct for your server configuration
- Test thoroughly in a development environment before production deployment
- Monitor logs after deployment for any issues
- Have support team ready for user questions during transition