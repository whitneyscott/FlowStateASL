# ASL Express LTI Tool Setup Guide

## Overview

This guide explains how to set up two separate LTI tools in Canvas for the ASL Express vocabulary learning system:

1. **ASLExpress Flashcards** - Interactive vocabulary flashcards
2. **ASLExpress Prompt Manager** - Timed practice and recording tool

## Prerequisites

- Canvas LMS administrator access
- LTI consumer key and shared secret
- Files deployed to `SproutCanvas/dev/` folder on your server

## File Structure

Ensure these files are present in your `SproutCanvas/dev/` folder:

```
SproutCanvas/dev/
├── lti_launch.php          # Flashcards LTI handler
├── lti_timed_launch.php    # Prompt Manager LTI handler  
├── flashcards.php          # Flashcard interface
├── timer.php              # Prompt Manager interface
├── canvas_bridge.php      # Canvas API bridge
├── sprout_bridge.php      # SproutVideo API bridge
├── .env                   # Environment configuration
└── [other support files]
```

## Tool 1: ASLExpress Flashcards

### Purpose
Interactive vocabulary flashcards with ASL video content, supporting three learning modes:
- Rehearsal mode
- Tutorial mode  
- Screening mode

### Canvas Configuration

1. **Navigate to Canvas Settings:**
   - Go to your course
   - Click "Settings" in the left navigation
   - Select "Apps" tab

2. **Add New App:**
   - Click "+ App" button
   - Select "By URL" as Configuration Type

3. **Configure App Settings:**
   ```
   Name: ASLExpress Flashcards
   Consumer Key: [your LTI consumer key]
   Shared Secret: [your LTI shared secret]
   Launch URL: https://yourdomain.com/SproutCanvas/dev/lti_launch.php
   ```

4. **Configure Placements:**
   - **Course Navigation**: Enable
     - Placements: "Course Navigation"
     - Name: "Flashcards"
     - Visibility: "Public"
   - **Account Navigation**: Enable (optional)
     - Placements: "Account Navigation"
     - Name: "Flashcards"
     - Visibility: "Account Only"

5. **Save Configuration**

## Tool 2: ASLExpress Prompt Manager

### Purpose
Timed practice tool for ASL vocabulary warm-up sessions with video recording:
- 5-minute configurable warm-up timer
- Rich text prompt editor for instructors
- Real-time video preview and recording
- Automatic video download and Canvas module integration

### Canvas Configuration

1. **Navigate to Canvas Settings:**
   - Go to your course
   - Click "Settings" in the left navigation
   - Select "Apps" tab

2. **Add New App:**
   - Click "+ App" button
   - Select "By URL" as Configuration Type

3. **Configure App Settings:**
   ```
   Name: ASLExpress Prompt Manager
   Consumer Key: [your LTI consumer key]
   Shared Secret: [your LTI shared secret]
   Launch URL: https://yourdomain.com/SproutCanvas/dev/lti_timed_launch.php
   ```

4. **Configure Placements:**
   - **Course Navigation**: Enable
     - Placements: "Course Navigation"
     - Name: "Prompt Manager"
     - Visibility: "Public"
   - **Account Navigation**: Enable (optional)
     - Placements: "Account Navigation"
     - Name: "Prompt Manager"
     - Visibility: "Account Only"

5. **Save Configuration**

## Testing the Setup

### Test Flashcards Tool
1. Navigate to your course
2. Click "Flashcards" in the left navigation
3. Verify it loads the flashcard interface
4. Test with different modules to ensure proper content loading

### Test Prompt Manager Tool
1. Navigate to your course
2. Click "Prompt Manager" in the left navigation
3. Verify it loads the timer interface
4. Test the warm-up timer and recording functionality

## Troubleshooting

### Common Issues

**Issue: Tool doesn't appear in navigation**
- Check that "Course Navigation" placement is enabled
- Verify the tool is published/available
- Ensure proper permissions are set

**Issue: Redirects to wrong page**
- Verify the Launch URL is correct
- Check that files exist in the specified location
- Ensure no typos in the URL

**Issue: Authentication errors**
- Verify Consumer Key and Shared Secret are correct
- Check that LTI configuration matches your LMS settings
- Ensure proper SSL certificate on your server

**Issue: Content not loading**
- Verify `.env` file has correct API keys
- Check that SproutVideo and Canvas API keys are valid
- Ensure network connectivity to external APIs

### Debug Mode

Enable debug mode by adding `?debug=1` to any URL:
- `https://yourdomain.com/SproutCanvas/dev/test_timed_flow.php?debug=1`

This will show diagnostic information about API responses and file accessibility.

## Security Considerations

- Keep API keys secure in `.env` file
- Use HTTPS for all LTI endpoints
- Implement proper input validation
- Monitor access logs for unusual activity
- Regularly update API keys

## Support

For technical support:
1. Check the troubleshooting section above
2. Review server logs for error messages
3. Verify all required files are present
4. Test API connectivity with the debug tools

## File Descriptions

### Core LTI Files
- `lti_launch.php` - Handles flashcard tool launches
- `lti_timed_launch.php` - Handles prompt manager tool launches

### Application Files
- `flashcards.php` - Main flashcard interface
- `timer.php` - Timed practice and recording interface

### Bridge Files
- `canvas_bridge.php` - Canvas API integration
- `sprout_bridge.php` - SproutVideo API integration

### Support Files
- `.env` - Environment configuration
- `test_timed_flow.php` - Diagnostic and testing tool