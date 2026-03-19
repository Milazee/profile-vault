// Profile Vault — background.js (MV3 Service Worker)

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-6';

// ─── Safe JSON parser ─────────────────────────────────────────────────────────
// Fixes literal control characters (newline, tab, CR) inside JSON string values.
// Claude occasionally emits bare newlines inside strings, which breaks JSON.parse.
// We walk the raw text character-by-character so we only sanitize inside strings.

function safeParseJSON(raw) {
  let out = '';
  let inString = false;
  let escaped  = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString) {
      // Replace bare control characters inside strings with JSON escape sequences
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }

    out += ch;
  }

  return JSON.parse(out);
}

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'parseResume') {
    handleParseResume(message).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.action === 'fillPage') {
    handleFillPage().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ─── Parse resume ─────────────────────────────────────────────────────────────

async function handleParseResume({ fileData, fileType, fileName }) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('No API key configured. Open Options to add your Anthropic API key.');

  const systemPrompt = `You are a resume parser. Extract structured profile data from the provided resume.
Return ONLY a valid JSON object with these exact fields (use empty string "" for missing text, empty array [] for missing lists):
{
  "firstName": "first name",
  "lastName": "last name",
  "preferredName": "nickname or goes-by name if different from first name, otherwise empty string",
  "name": "full name (firstName + lastName)",
  "legalFirstName": "legal first name (same as firstName if not specified)",
  "legalLastName": "legal last name (same as lastName if not specified)",
  "legalName": "full legal name",
  "email": "email address",
  "phone": "phone number",
  "title": "current or most recent job title",
  "company": "current or most recent employer",
  "location": "city, state/country (e.g. San Francisco, CA)",
  "address": "street address (number and street only, no city/state/zip)",
  "city": "city name",
  "state": "state or province abbreviation or name",
  "zip": "ZIP or postal code",
  "country": "country name",
  "linkedin": "LinkedIn URL or username",
  "skills": ["skill1", "skill2"],
  "certifications": [
    {
      "certName": "certification name",
      "issuingOrg": "certifying body or organization",
      "credentialId": "credential or license ID if present",
      "issueYear": "YYYY or empty",
      "expiryYear": "YYYY or empty"
    }
  ],
  "summary": "2-3 sentence professional summary written in first person",
  "education": [
    {
      "school": "school/university name",
      "degree": "degree and field of study",
      "startMonth": "1-12 or empty",
      "startYear": "YYYY or empty",
      "endMonth": "1-12 or empty",
      "endYear": "YYYY or empty"
    }
  ],
  "experience": [
    {
      "title": "job title",
      "company": "company name",
      "location": "city, state/country",
      "description": ["key achievement or responsibility as a concise bullet", "another bullet"],
      "startMonth": "1-12 or empty",
      "startYear": "YYYY or empty",
      "endMonth": "1-12 or empty",
      "endYear": "YYYY or empty (empty if current)"
    }
  ]
}
Rules:
- description must be a JSON array of short strings — never a single string with newlines
- All string values must be on one line — no literal newline characters inside strings
- Order education and experience with most recent first
Return ONLY the JSON object. No markdown fences, no explanation.`;

  let userContent;

  if (fileType === 'pdf') {
    userContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: fileData }
      },
      { type: 'text', text: 'Extract the profile data from this resume as JSON.' }
    ];
  } else {
    userContent = `Here is the resume text:\n\n${fileData}\n\nExtract the profile data as JSON.`;
  }

  const body = {
    model: MODEL,
    max_tokens: 2500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'pdfs-2024-09-25',
    'anthropic-dangerous-direct-browser-access': 'true'
  };

  const response = await fetch(ANTHROPIC_API, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || `API error ${response.status}`;
    throw new Error(msg);
  }

  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned an unexpected response. Try again.');

  return safeParseJSON(jsonMatch[0]);
}

// ─── Fill This Page ───────────────────────────────────────────────────────────

async function handleFillPage() {
  const { apiKey, profile } = await chrome.storage.local.get(['apiKey', 'profile']);
  if (!apiKey) throw new Error('No API key configured.');
  if (!profile) throw new Error('No profile found. Parse a resume first.');

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  // Content script is injected via manifest, but may not run on restricted pages
  let fields;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: 'scanFields' });
    fields = result?.fields;
  } catch {
    throw new Error('Cannot access this page. Try a regular website.');
  }

  if (!fields || fields.length === 0) {
    return { filled: 0, message: 'No fillable form fields found on this page.' };
  }

  // Ask Claude which fields to fill
  const fills = await askClaudeToFillFields(profile, fields, apiKey);

  if (!fills || fills.length === 0) {
    return { filled: 0 };
  }

  // Send fill instructions to content script
  const fillResult = await chrome.tabs.sendMessage(tab.id, { action: 'fillFields', fills });
  return { filled: fillResult?.filled || fills.length };
}

async function askClaudeToFillFields(profile, fields, apiKey) {
  // Convert experience description arrays to readable bullet strings for Claude
  const profileForFill = JSON.parse(JSON.stringify(profile));
  if (Array.isArray(profileForFill.experience)) {
    profileForFill.experience = profileForFill.experience.map(e => ({
      ...e,
      description: Array.isArray(e.description)
        ? e.description.map(b => `• ${b.replace(/^[•\-]\s*/, '')}`).join('\n')
        : (e.description || '')
    }));
  }
  // Derive both state abbreviation and full name so Claude can use the right form
  const US_STATES = {
    AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
    CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
    IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
    ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
    MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
    NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',
    ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',
    RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',
    UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',
    WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'
  };
  const STATES_REVERSE = Object.fromEntries(Object.entries(US_STATES).map(([k,v]) => [v.toUpperCase(), k]));
  const rawState = (profileForFill.state || '').trim();
  const rawUpper = rawState.toUpperCase();
  profileForFill.stateAbbr = US_STATES[rawUpper] ? rawUpper : (STATES_REVERSE[rawUpper] || rawState);
  profileForFill.stateFull = US_STATES[rawUpper] || (US_STATES[STATES_REVERSE[rawUpper]] ? US_STATES[STATES_REVERSE[rawUpper]] : rawState);

  const profileSummary = JSON.stringify(profileForFill, null, 2);
  const fieldList = fields.map((f, i) =>
    `${i + 1}. idx=${f.idx} | type="${f.type}"${f.type === 'radio' ? ` | radioValue="${f.radioValue}"` : ''} | label="${f.label}" | name="${f.name}" | placeholder="${f.placeholder}" | autocomplete="${f.autocomplete}"${f.context ? ` | section="${f.context}"` : ''}`
  ).join('\n');

  const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const prompt = `You are helping auto-fill a job application form.

USER PROFILE:
${profileSummary}

FORM FIELDS FOUND ON PAGE:
${fieldList}

Task: Determine which profile values should fill which form fields.
Match fields by their label, name, placeholder, or autocomplete attribute to the user's profile data.

Return ONLY a JSON array. Each entry must have:
- "idx": the field's idx number (integer)
- "value": the string value to fill in

Matching rules:
- "pronouns", "your pronouns", "preferred pronouns", "pronoun" → pronouns (text input: fill directly; radio button group: return the idx of the radio whose radioValue best matches the stored pronouns, e.g. stored "he/him" → select radio with radioValue "He/him/his"; stored "she/her" → "She/her/hers"; stored "they/them" → "They/them/theirs"; if no close match exists select the radio with radioValue containing "Other" or "Prefer not to disclose")
- "first name" → firstName
- "last name" → lastName
- "full name" or "name" (single field) → name (firstName + lastName)
- "legal first name" → legalFirstName
- "legal last name" → legalLastName
- "legal name" or "full legal name" → legalName
- "email" → email
- "phone" → phone
- "street address", "address line 1", "street" → profile address
- "city" (standalone field) → profile city
- "state", "province", "state/province", "location", "state of residency", "state of residence", "current state", "current location", "state you live in", "state of employment", "where are you located" text input → profile stateAbbr (2-letter abbreviation, e.g. "CA")
- "state", "province", "state/province", "location", "state of residency", "state of residence", "current state", "current location" select/combobox/dropdown → profile stateFull (full name, e.g. "California"); the fill engine will fuzzy-match to the available option. For location comboboxes use profile city as the search term (e.g. "Los Angeles") so the API returns results.
- "zip", "zip code", "postal code" → profile zip
- "country" → profile country
- "linkedin" → linkedin
- "company", "employer", "organization" → most recent experience company
- "job title", "position", "role" → most recent experience title
- "start date", "from" near a job/education section → startMonth/startYear of most recent relevant entry
- "end date", "to" near a job/education section → endMonth/endYear of most recent relevant entry
- For month fields: use full month name (e.g. "January") or number (1-12) depending on field type
- For year fields: use 4-digit year
- "school", "university", "institution" → most recent education school
- "degree", "field of study" → most recent education degree
- "description", "responsibilities", "about role" → most recent experience description (join the array items with newlines, prefixing each with "• ")
- "summary", "about me", "cover" textarea → profile summary
- "skills" textarea → skills joined with commas
- "certification", "license" fields → most relevant certification name
- "issuing organization", "certifying body" → issuingOrg of most relevant cert
- "credential id", "license number" → credentialId of most relevant cert
- "issue date", "certification date" → issueYear of most relevant cert
- "expiration date", "expiry" → expiryYear of most relevant cert

COMBOBOX FIELDS (type="combobox") — custom dropdown components (Ashby EEO selects, etc.):
- Treat these exactly like select fields: output the stored preference value as the value.
- The fill engine will open the dropdown and fuzzy-match against the visible options.
- Apply the same EEO/compliance matching rules as you would for a select field.
- EXCEPTION — "city" standalone comboboxes: output ONLY the city name (e.g. "Los Angeles"), NOT "City, ST".

RADIO BUTTONS (type="radio"):
- Each radio button has its own idx and radioValue showing what it represents.
- To select an option, return {idx: <idx of the specific radio to check>, value: "checked"}.
- Only return ONE radio button per named group (the one that matches the desired answer).
- For Yes/No radio groups: match "Yes"/"No" radioValue to the appropriate answer.

CHECKBOX FIELDS (type="checkbox"):
- Each checkbox has its own idx, label, and radioValue describing what it represents.
- To check a box, return {idx: <idx>, value: "checked"}. Never return a checkbox entry to uncheck.
- Pronoun checkboxes: check the one(s) whose label best matches profile.pronouns.
- Skill / interest / tool checkboxes: check boxes whose label matches an entry in profile.skills.
- Community / identity checkboxes ("which communities do you identify with", "I identify as", diversity checkboxes):
    Check boxes whose label fuzzy-matches an entry in eeo.communities.
    If eeo.communities includes "None of the above" → check only that box and no others.
    If eeo.communities includes "Prefer not to answer" and no other community items are checked → check only that box.
    If eeo.communities is empty → skip.
- Any other checkbox whose label clearly matches a known profile value: check it.
- If the stored profile value is empty or nothing clearly matches, skip the checkbox entirely.
- NEVER check agreement, consent, terms-of-service, privacy-policy, or opt-in checkboxes.

AGE ELIGIBILITY:
- "are you 18 years of age or older", "are you at least 18", "are you over 18", "are you 18+", "minimum age requirement", "I am at least 18" → Yes (for radio/Yes-No buttons return the "Yes" radio idx; for checkboxes return value "checked")
- Age-range select fields (options like "18–24", "25–34", etc.) → skip unless birthdate is in profile.

COMPANY-SPECIFIC PRIOR EMPLOYMENT:
- "Have you ever been an employee / contractor / worked at [company]?" → select/return "No"
- "Have you previously worked at [company]?" → "No"
- "Have you ever been credentialed / registered / licensed / approved with [company]?" → "No"
- "Are you a former employee of [company]?" → "No"
(Assume this is the candidate's first application — they have no prior relationship with this company)

DESIRED PAY — use profile.pay values (only if non-empty):
- "desired salary", "expected salary", "salary expectation", "compensation", "what are your salary expectations" → pay.target (or pay.min–pay.max range if both set, e.g. "100000" or "80000-120000")
- "minimum salary", "salary minimum", "lowest acceptable" → pay.min
- "maximum salary", "salary maximum" → pay.max
- "pay type", "compensation type", "salary or hourly" → pay.type
- "hourly rate", "desired rate" → pay.target (the stored number, for hourly contexts)
- "currency" → pay.currency
Skip any pay field where the stored preference is empty.

EEO & COMPLIANCE FIELDS — use profile.eeo values (only if non-empty):
- "authorized to work", "work authorization", "legally authorized", "eligible to work", "right to work", "currently eligible to work", "currently authorized", "eligible to work in the united states" → eeo.workAuth (e.g. "Yes" or "No")
- "sponsorship", "visa sponsorship", "require sponsorship", "work visa", "employment visa" → eeo.sponsorship (e.g. "No" or "Yes")
- "gender", "sex" (when it is a standalone demographic question, not part of a name field) → eeo.gender (e.g. "Male", "Female", "Non-binary", "Prefer not to disclose")
- "hispanic", "latino", "hispanic or latino", "hispanic/latino", "ethnicity" when it is the hispanic/latino binary question → eeo.hispanic (e.g. "No", "Yes", "Decline to self-identify")
- "race", "racial", "ethnicity" / "race and ethnicity" when it is a multi-option race category → eeo.race (e.g. "Black or African American", "White", etc.)
- "sexual orientation" → eeo.sexualOrientation; fuzzy-match stored value against the available options.
- "veteran", "veteran status", "protected veteran", "military service", "military status" formal compliance question:
    Derive answer from eeo.communities: if communities includes "Veteran" → "I identify as a protected veteran"; if communities includes "Prefer not to answer" → "I prefer not to answer"; if communities is non-empty but no Veteran entry → "I am not a protected veteran"; if communities is empty → skip.
- "disability", "disabled", "disability status", "section 503" formal compliance question:
    Derive from eeo.communities: if includes "Person with disability" → "Yes, I have a disability"; if includes "Prefer not to answer" → "I prefer not to answer"; if communities is non-empty but no disability entry → "No, I don't have a disability"; if communities is empty → skip.
For EEO selects: output the stored preference value exactly — the fill engine will fuzzy-match.
For EEO radio buttons: use the RADIO BUTTONS rule above — return the idx of the specific radio whose radioValue matches the stored preference (e.g. eeo.workAuth = "Yes" → return the "Yes" radio button idx).
Skip any EEO field where the stored preference is empty.

RESUME FILE UPLOAD FIELDS:
- File inputs labeled "resume", "CV", "curriculum vitae", "upload resume", "attach resume", "upload CV", or accepting .pdf/.doc/.docx → return value "__RESUME__" to trigger attaching the stored resume file.
- Skip all other file inputs.

GENERATED CONTENT FIELDS — for open-ended text fields where no stored profile value directly applies, write natural first-person content using the candidate's profile as context:
- "cover letter", "why are you interested in this role / company", "why do you want to work here", "motivation letter", "letter of interest", "message to hiring manager" → write a concise 3–4 sentence cover paragraph drawing on their most recent experience, relevant skills, and professional summary.
- "tell us about yourself", "self introduction", "brief introduction", "about you" → write a 2–3 sentence professional intro based on their title, experience, and top skills.
- "what makes you a good fit", "why should we hire you", "how do you meet the requirements" → write 2–3 sentences highlighting relevant experience and skills.
- "how did you hear about us", "referral source" → skip (leave empty).
- "additional information", "anything else to add", "additional comments" → skip unless the field is clearly about qualifications.
- Any other open-ended textarea or text field that is clearly a personality, culture-fit, or fun question (e.g. "What snack fuels your best ideas?", "What's your superpower?", "Describe yourself in three words", "What are you passionate about?", "Tell us something fun about you") → write a short, genuine, conversational 1–2 sentence response that reflects the candidate's professional identity and personality based on their profile. Keep it light but authentic.
For all generated content: write in first person, keep it genuine and professional, and ground it firmly in the actual profile data (don't invent details).

Skip hidden, submit, button, and uncategorized checkbox fields (consent/agreement boxes are never checked).
Only include fields you are confident about.
Return [] if nothing clearly matches.

Return ONLY the JSON array, no explanation.`;

  const body = {
    model: MODEL,
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }]
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };

  const response = await fetch(ANTHROPIC_API, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || `API error ${response.status}`;
    throw new Error(msg);
  }

  const text = data.content?.[0]?.text || '';
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];

  return safeParseJSON(arrMatch[0]);
}
