# Profile Vault

A Chrome extension that parses your resume with Claude AI and auto-fills job application forms.

## Features

- Upload your resume (PDF, DOCX, or TXT)
- Claude AI extracts your profile: name, contact info, work history, education, skills, and more
- One-click form filling on any job application page
- Supports text inputs, dropdowns, radio buttons, checkboxes, and comboboxes
- Handles EEO/compliance fields, salary fields, and generates cover letter text

## Requirements

- Google Chrome (or any Chromium-based browser)
- An [Anthropic API key](https://console.anthropic.com/)

## Installation

This extension is not yet published to the Chrome Web Store. Install it in developer mode:

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `profile-vault` folder
5. The Profile Vault icon will appear in your toolbar

## Setup

1. Click the Profile Vault icon and then **Options** (or right-click the icon → Options)
2. Paste your Anthropic API key and click **Save**

## Usage

### Parsing your resume

1. Click the Profile Vault icon
2. Drag and drop your resume or click to browse (PDF, DOCX, or TXT supported)
3. Click **Parse Resume** — Claude will extract your profile in a few seconds
4. Your profile is saved locally in Chrome storage

### Auto-filling a form

1. Navigate to a job application page
2. Click the Profile Vault icon
3. Click **Fill This Page**
4. Claude scans the form fields and fills in the matching values

### Updating your profile

Click **Replace Resume** in the popup to upload a new resume and re-parse.

## Privacy

- Your resume and profile data are stored locally in Chrome's storage — nothing is sent to any server other than the Anthropic API for parsing
- Your API key is stored locally and sent only to `api.anthropic.com`
- No analytics or tracking

## Project Structure

```
profile-vault/
├── manifest.json      # Chrome extension manifest (MV3)
├── background.js      # Service worker: Claude API calls, form-fill logic
├── content.js         # Injected into pages: field scanning and filling
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic: file upload, profile display
├── options.html       # Options page UI
└── options.js         # Options logic: API key management, profile editor
```

## Development

The extension uses Manifest V3. All Claude API calls are made from `background.js` (the service worker) using the `anthropic-dangerous-direct-browser-access` header, which allows browser-side API requests.

To make changes: edit the files, then go to `chrome://extensions` and click the refresh icon on the Profile Vault card.

## License

MIT
