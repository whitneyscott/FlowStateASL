# ASL Express Flashcards Project Documentation

## Overview

This project is a comprehensive ASL (American Sign Language) vocabulary learning system designed for integration with Canvas LMS. It provides interactive flashcards, timed practice sessions, and LTI (Learning Tools Interoperability) integration for seamless use within educational environments.

## Project Structure

### Configuration Files

#### `.env`
- **Purpose**: Environment configuration file containing API keys and domain settings
- **Key Components**:
  - `SPROUT_KEY`: API key for SproutVideo service (video hosting)
  - `ASL_LEGACY_PHP_CANVAS_BEARER`: Optional Canvas bearer **only** for legacy PHP scripts (`timer.php`, `canvas_bridge.php`). The Nest API uses per-course encrypted tokens in Postgres, not env-based shared tokens.
  - `CANVAS_DOMAIN`: Canvas instance domain (tjc.instructure.com)
- **Security**: Contains sensitive credentials, should not be committed to version control

### Core Application Files

#### `flashcards.php`
- **Purpose**: Main flashcard application interface
- **Key Features**:
  - Interactive vocabulary flashcards with ASL video content
  - Three learning modes: Rehearsal, Tutorial, and Screening
  - Configurable timer settings and display options
  - Progress tracking and scoring system
  - Support for both English-first and ASL-first learning
  - Typing mode for ASL-to-English practice
  - Benchmark tracking (85% minimum score recommendation)
  - Deck management (shuffle, reset, retry missed items)
- **Integration**: Works with Canvas LTI parameters to load appropriate content
- **UI**: Responsive design with dark theme, progress indicators, and video embedding

#### `timer.php`
- **Purpose**: Timed practice tool for ASL vocabulary warm-up sessions
- **Key Features**:
  - Configurable warm-up timer (default 5 minutes)
  - Rich text prompt editor for instructors
  - Real-time video preview and recording functionality
  - Countdown overlay before recording starts
  - Automatic video download after recording
  - Canvas module integration for assignment submission
- **Workflow**:
  1. Warm-up phase with prompts
  2. Preflight check with camera preview
  3. Recording phase with countdown
  4. Download and redirect to Canvas modules
- **Security**: Implements CSP headers for iframe security

### API Bridge Files

#### `canvas_bridge.php`
- **Purpose**: Bridge between Canvas LMS and the flashcard system
- **Key Functions**:
  - Fetches module information from Canvas API using course_id and module_id
  - Extracts unit numbers from module names (e.g., "Unit 5.1" → "TWA.05.01")
  - Generates filter strings for content selection
  - Handles LTI parameter validation and error handling
  - Implements demo-safe patches for error recovery
- **Output**: JSON response with module details and filter parameters

#### `sprout_bridge.php`
- **Purpose**: Bridge to SproutVideo API for content management
- **Key Functions**:
  - Fetches playlists from SproutVideo based on filter criteria
  - Retrieves individual video details for flashcard content
  - Implements smart version matching for playlist titles
  - Blacklist filtering to exclude exam/test content
  - Handles both playlist listing and individual video retrieval
- **Smart Matching**: Supports multiple format variations (TWA.05.01, TWA 05.01, etc.)
- **Caching**: Includes cache-busting parameters to prevent stale data

### LTI Integration Files

#### `lti_launch.php`
- **Purpose**: Entry point for LTI launches of the flashcard application
- **Key Functions**:
  - Validates LTI parameters (course_id, module_id)
  - Redirects to flashcards.php with proper parameters
  - Implements demo-safe error handling
  - Supports both POST (LTI) and direct URL access
- **Security**: Validates required parameters before proceeding

#### `lti_timed_launch.php`
- **Purpose**: Entry point for LTI launches of the timed practice tool
- **Key Functions**:
  - Similar validation and redirection pattern as lti_launch.php
  - Specifically routes to timer.php for timed practice sessions
  - Maintains consistency with the main LTI launch pattern

### Utility and Support Files

#### `ai_proxy.php`
- **Purpose**: Proxy for AI services (Cohere API)
- **Key Functions**:
  - Provides API key security by proxying requests
  - Implements document reranking functionality
  - Handles JSON input/output processing
  - Error handling and HTTP status code management

#### `hf_proxy.php`
- **Purpose**: Proxy for Hugging Face inference API
- **Key Functions**:
  - Secure proxy for cross-encoder model access
  - Environment variable loading for API tokens
  - Error handling and response logging
  - cURL extension validation

#### `save_session.php`
- **Purpose**: Session scoring and Canvas grade submission
- **Key Functions**:
  - Processes session scores and generates Canvas submission payload
  - Differentiates between tutorial (non-graded) and practice modes
  - Calculates percentage-based grades for Canvas integration
  - Returns structured response for frontend processing

#### `test_timed_flow.php`
- **Purpose**: Testing and validation script for the timed practice workflow
- **Key Functions**:
  - Validates file existence and accessibility
  - Tests API bridge functionality with sample data
  - Provides diagnostic output for troubleshooting
  - Documents expected workflow and configuration requirements

### Configuration Files

#### `settings_2622865.json`
- **Purpose**: Example configuration file (appears to be a sample settings file)
- **Content**: Contains sample timing settings, prompts, and access codes
- **Note**: This appears to be a template or example file rather than active configuration

## System Architecture

### Data Flow

1. **LTI Launch**: Canvas launches the tool via LTI parameters
2. **Parameter Processing**: Bridge files extract and validate course/module information
3. **Content Retrieval**: SproutVideo API provides relevant vocabulary content
4. **User Interface**: Flashcard or timer interface loads with appropriate content
5. **Session Management**: User progress and scores are tracked
6. **Grade Submission**: Scores can be submitted back to Canvas via save_session.php

### Integration Points

- **Canvas LMS**: Full LTI integration for seamless course integration
- **SproutVideo**: Video hosting and content management
- **AI Services**: Optional integration with Cohere and Hugging Face APIs
- **Canvas API**: Grade submission and module navigation

## Security Features

- **CSP Headers**: Content Security Policy for iframe security
- **API Key Protection**: Proxy files prevent direct exposure of API credentials
- **Input Validation**: Comprehensive parameter validation in LTI handlers
- **Error Handling**: Graceful degradation and demo-safe error recovery

## LTI Tool Configuration

### Two-Tool Setup (Recommended)

The system supports two separate LTI tools for different learning functions:

#### Tool 1: ASLExpress Flashcards
- **Launch URL**: `https://yourdomain.com/SproutCanvas/dev/lti_launch.php`
- **Purpose**: Interactive vocabulary flashcards
- **Features**: Rehearsal, Tutorial, and Screening modes
- **Canvas Placement**: "Flashcards" in Course Navigation

#### Tool 2: ASLExpress Prompt Manager  
- **Launch URL**: `https://yourdomain.com/SproutCanvas/dev/lti_timed_launch.php`
- **Purpose**: Timed practice and recording tool
- **Features**: 5-minute warm-up, video recording, prompt management
- **Canvas Placement**: "Prompt Manager" in Course Navigation

### Deployment Structure

For production deployment, files should be organized as:
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

## Usage Scenarios

### Flashcard Learning (Tool 1)
1. Instructor configures "ASLExpress Flashcards" LTI tool in Canvas
2. Students launch flashcards from Canvas course navigation
3. System loads vocabulary specific to the current unit
4. Students practice with various modes and settings
5. Progress is tracked and can be submitted to Canvas

### Timed Practice (Tool 2)
1. Instructor configures "ASLExpress Prompt Manager" LTI tool in Canvas
2. Students launch timed warm-up session from Canvas
3. System displays prompts for 5-minute warm-up
4. Students record themselves signing vocabulary
5. Video is downloaded and uploaded to Canvas assignment

### Combined Workflow
1. Students use Flashcards tool for vocabulary practice
2. Students use Prompt Manager tool for timed recording practice
3. Both tools integrate seamlessly with Canvas LMS
4. Progress and submissions flow back to Canvas gradebook

This documentation provides a comprehensive overview of the ASL Express Flashcards project, its components, and their interrelationships.