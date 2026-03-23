# Profile Vault

A Chrome extension that acts as a personal data vault for job seekers. Store all your professional information once, and let Profile Vault auto-fill job applications for you — no more typing the same details over and over.

## What It Does

Job applications ask for the same information repeatedly: your name, contact details, work history, education, skills, and more. Profile Vault solves this by:

- **Parsing your resume** — upload once and Claude AI extracts all your information automatically
- **Auto-filling forms** — one click fills in text fields, dropdowns, radio buttons, checkboxes, and more
- **Attaching your resume** — automatically handles file upload fields on application forms
- **Saving your responses** — stores answers you've written for common questions (e.g. "Why do you want to work here?")
- **Generating responses** — uses Claude AI to draft answers for open-ended questions based on your profile
- **Auto-saving** — all changes to your profile are saved automatically

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

1. Click the Profile Vault icon → **Options** (or right-click the icon → Options)
2. Paste your Anthropic API key and click **Save**

## Usage

### 1. Build your vault

1. Click the Profile Vault icon
2. Drag and drop your resume or click to browse (PDF, DOCX, or TXT supported)
3. Click **Parse Resume** — Claude extracts your name, contact info, work history, education, skills, and more
4. Your profile is saved locally in Chrome — no account needed

### 2. Auto-fill a job application

1. Navigate to any job application page
2. Click the Profile Vault icon
3. Click **Fill This Page**
4. Claude scans the form and fills in every matching field using your vault data

### 3. Update your profile

Click **Replace Resume** to upload a new resume and re-parse, or edit fields directly in the options page — changes save automatically.

## Privacy

- All your data stays on your device in Chrome's local storage
- The only external service used is the Anthropic API (for resume parsing and response generation)
- Your API key is stored locally and sent only to `api.anthropic.com`
- No analytics, no tracking, no servers

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

Built with Manifest V3. All Claude API calls are made from `background.js` using the `anthropic-dangerous-direct-browser-access` header for browser-side API access.

To make changes: edit the files, then go to `chrome://extensions` and click the refresh icon on the Profile Vault card.

## License

MIT
