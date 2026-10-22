# Handwritten prescription scanner

Scan → read → review → approve → import. Paper prescriptions become structured, reviewable information in the patient's record. Nothing enters the permanent record until the doctor has checked each field against the image and imported it.

## Workflow

1. **Capture.** From a consultation (*Scanned prescription → 📷 Scan / upload prescription*) or a patient profile (*📷 Scan prescription*), take a photo or upload a JPEG, PNG, WebP or PDF (max 15 MB). The file type is checked from the file's content, not its name.
2. **Clean up** (images):
   - The app finds the page edges automatically (Otsu threshold → largest bright region → its four corners). If it cannot find them confidently it says so and uses the whole photo instead of guessing. Drag the four corners to adjust them, or tap *Detect page edges* to try again. The corners crop the photo and correct perspective (a 4-point homography).
   - Rotate by 90°, or straighten by ±15°.
   - Adjust brightness and contrast, use greyscale, and optionally "sharpen ink" (adaptive threshold for shadows or faint pen).

   The original is never modified. A cleaned-up JPEG (≤ 2000 px) is produced, and both are kept.
3. **Read.** Choose one of two readers:
   - **AI (cloud, opt-in):** Claude reads the handwriting. It is off until a doctor enables it and accepts the disclosure.
   - **Type it myself:** no cloud. The image is shown beside an empty form.
4. **Patient.** When started from a patient or consultation, the patient is known. The app compares the name, age and sex written on the paper with the record, and a mismatch must be explicitly confirmed (or the scan rejected). When started without a patient, the app lists possible matches but never picks one: the user selects an existing patient or registers a new one. The images are saved, encrypted, only after this step.
5. **Review.** The image sits beside the extracted fields: side by side on desktop, pinned above them on a phone, and tap to enlarge. The fields are grouped into prescription details, patient details (identification only), complaints, comorbidities, vitals, examination, diagnosis, investigations, medicines, advice and follow-up. Each field shows:
   - the text **as read**, its legibility and the confidence;
   - **flags**: illegible, unclear, low confidence, ambiguous (with alternative readings), not written, conflict, medicine not in catalogue, similar name, partial name, implausible value;
   - **hints**, e.g. "1-0-1 → 1 morning, 1 night", "BD → twice daily", "खाने के बाद → after food", "5/7 → 5 days", "Dolo = paracetamol". Hints are never substituted for the text;
   - an editable value, **Approve** and **Reject** buttons, and its own history.

   Items the reader missed can be added. *Approve all clearly read fields* approves only fields with no flag at all, after a confirmation.
6. **Import** (doctor only). Into the current draft consultation, or into a new "Paper prescription (scanned)" consultation dated from the approved prescription date, with no fee. It stays a draft for the doctor to sign. Everything is validated before anything is written.

## Safety rules (enforced by the data layer, not just the screen)

| Rule | How |
|---|---|
| Never guess a drug name, strength, dose, frequency or duration | If the reading is uncertain, ambiguous, illegible, not written, a near-miss of a catalogue name, or only a partial match, it cannot be approved until the doctor **types** the value. Ticking "checked" is not enough for these. |
| Other uncertain fields | They need either an edit or an explicit "I checked this against the image". |
| No confirmed diagnosis from an ambiguous phrase | Diagnoses default to provisional (or suspected for "?"). "Confirmed" is refused for an uncertain reading unless the doctor typed the diagnosis. |
| No prescription or dispensing from OCR | Medicines are imported as **unverified medicine history** (status unknown, "not verified" badge, a "not prescribed in this app" note). No prescription record is created. To re-prescribe, the doctor writes and approves a prescription as usual. |
| Never overwrite | Complaints, advice and notes are appended. An existing examination finding gets the scanned text appended, and its status is kept. Existing prescriptions are untouched. Signed consultations cannot receive imports. Investigation results are new records. |
| Patient must be confident | A name, age or sex mismatch, or a prescription with no patient details, blocks import until the doctor confirms the patient. The scan can be rejected as the wrong patient. |
| Implausible values | Vitals go through the same plausibility checks as manual entry. For example, "101" recorded as a temperature is flagged as probably °F and must be edited to °C. |
| Unreadable images | If the reader reports an unreadable or non-medical image, the app offers to retake the photo, enter the details manually, or review anyway. |
| Explicit approval | Import needs the doctor's sign-off permission and imports only approved fields. Fields still pending are left out. A medicine with approved details but an unreviewed name blocks the import until it is approved or rejected. |
| Provenance and history | The raw reading is stored unchanged. Every field keeps its edit and approval history. Each imported record carries `source: { type: "scan", scanId, fieldIds }`. The scan keeps an import log and its own history. The original and enhanced images remain encrypted attachments. |

## Architecture

```
js/ocr/geometry.js     homography, perspective warp, contrast, adaptive threshold (pure)
js/ocr/preprocess.js   canvas pipeline in the browser (EXIF-aware load, rotate, warp, JPEG)
js/ocr/schema.js       structured-output JSON schema, validation, review fields + flags (pure)
js/ocr/medicines.js    medicine reference catalogue + matching (suggest, never substitute)
js/ocr/abbreviations.js  OD/BD/TDS/1-0-1/x5d/5/7 and Hindi timing → hints (pure)
js/ocr/claude.js       the cloud reader: Anthropic SDK call, error mapping
js/scan-store.js       scans store + review/approve/import rules (the only part that touches records)
js/ui/scan.js          capture, clean-up, read, patient, review, import screens
vendor/anthropic-sdk.mjs  the official @anthropic-ai/sdk bundled for the browser (scripts/vendor-sdk.js)
```

**OCR processing is separate from the patient database.** `js/ocr/*` never imports the store. The reader receives only image bytes and returns a validated extraction. The patient check, approval and import live in `scan-store.js`.

**The reader.**
- It uses the official Anthropic TypeScript/JavaScript SDK (`@anthropic-ai/sdk` 1.1.0, bundled once into `vendor/`, so the app stays a static site and loads no third-party script) with `claude-opus-5-5` at `effort: "high"`.
- **Structured output:** `output_config.format = { type: "json_schema", schema }`. Every value is a reading (`text`, `legibility` clear / unclear / illegible, `confidence` 0–1, `alternatives[]`). Absent (`text: null` + clear) is kept distinct from illegible.
- Server-side refusal fallback is on: `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta.
- The system prompt asks for verbatim transcription: keep abbreviations, brands and Devanagari; never guess; never infer a diagnosis; report image quality honestly.
- Responses are re-validated in the app. A refusal, truncation, unparseable result, auth error, rate limit or network error each gets a clear message and the manual-entry option.

**Medicine catalogue.** A starter set of about 160 common Indian brands, each mapped to its generic, plus about 110 generics, extended by the doctor's favourites and additions (*More → Clinical note & templates*). The result is one of:
- `exact`: "In catalogue: Dolo = paracetamol";
- `partial`: a variant such as "Augmentin Duo" — check the product;
- `similar`: "Azithrol" or "Azitrhal" (swapped letters count as one slip) → suggests Azithral, but is **not changed**;
- `none`: flagged for verification.

It is a spelling check, not a drug database or a recommendation. Doctors can **import a medicine list** (*More → Clinical note & templates*): a TXT file with one name per line, or a CSV with `name,generic`. Duplicates are skipped and the doctor confirms before saving. Imported names only widen the catalogue used for suggestions; a written name is never replaced.

## Privacy and security

- **Cloud is optional and off by default.** Enabling it is doctor-only and needs the disclosure to be accepted:
  - the image leaves the device to Anthropic over TLS;
  - only the image is sent, nothing from the record;
  - Anthropic's API terms and retention apply;
  - patient consent may be required (e.g. the DPDP Act 2023).

  Each scan asks again before sending. Without it, everything works with manual entry.
- **The API key** is stored in the encrypted `secrets` store (AES-GCM, the clinical data key) and is readable only while a doctor is signed in. It stays encrypted in backups. The app's Content-Security-Policy allows connections only to this site and `https://api.anthropic.com`. A proxy can be used instead of a key on the device, but it must be on the same site (e.g. `/ai-proxy`).
- **No public URLs.** Images are sent inline (base64), not via a file-upload API. On the device they are encrypted attachments, viewed through short-lived `blob:` URLs that are revoked. Extracted text is stored encrypted in the `scans` store.
- **Access.** Scanning needs the clinical-write permission and importing needs the doctor's sign-off permission. Receptionists cannot read or create scans, because they hold no key. Views, scans, cloud reads, imports and settings changes are logged in the clinical access log, without content.

## Database

Schema version 3 adds two encrypted stores. The upgrade is additive and preceded by a full on-device copy of the existing stores (encrypted clinical data stays encrypted).
- `scans`: in clear, only `patientId`, `encounterId` and `status`; encrypted content is the raw extraction, fields, flags, patient check, import log and history.
- `secrets`: the AI settings and key.

Backups are format 3; formats 1 and 2 still restore.

## Testing

`tests/scan.test.js` (17 tests) uses `tests/fixtures/prescriptions.js`: synthetic reader outputs modelled on Indian OPD prescriptions.
- **Fever:** cursive English with c/o, K/C/O DM and HTN, "? Viral fever", Dolo / Azithrol / Ascoril / Pan-D, 1-0-1, x 3d, 5/7, BBF, and a temperature written in °F.
- **Hindi/English:** सुबह, खाने के बाद, 1 महीने, an illegible frequency, a Devanagari name.
- **Unreadable photo.**
- **Conflicting strengths** and a mismatched patient name.

The tests cover validation, catalogue matching, abbreviations, flags, every approval rule, import with no fee and no prescription, append-only import, patient confirmation, manual entry, access control, encrypted key and backup, the reader's request shape and error handling, perspective geometry, automatic page-edge detection (including refusing to guess on a blank image), transposition-aware suggestions, medicine-list import, written-date parsing, and the schema 2 → 3 upgrade.

`tests/e2e/scan.test.js` runs the whole flow in Chromium at phone size. The Anthropic endpoint is intercepted, so it verifies that the bundled SDK sends the right model, headers and image, with no patient data. It then checks:
- an uncertain drug name cannot be approved until typed;
- bulk approval skips uncertain fields;
- the °F temperature and the unreviewed medicine name block the import;
- the import creates no prescription;
- the medicines appear as "not verified".

**Real handwriting accuracy** cannot be shown with synthetic data. Measure it on your own anonymised prescriptions:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run ocr:eval -- path/to/folder   # image + same-name .json ground truth
```

It reports per-field accuracy, character error rate (CER, so near-misses count partly), and **confident errors**: wrong values that were read as clear with high confidence, which the app would not flag. Until that number is zero on a representative sample (cursive writing, abbreviations, brand names, Hindi), keep reviewing every field against the image. That is the workflow's default anyway.

## Credits

Some ideas were adapted from [Aniket025/Medical-Prescription-OCR](https://github.com/Aniket025/Medical-Prescription-OCR):
- finding the page by its largest region and taking its corners from x+y and x−y;
- edit-distance (SymSpell-style) checking against a medicine vocabulary;
- measuring CER.

They were re-implemented here, and no code or word lists were copied: that repository has no license. One idea was deliberately not adopted: replacing a word automatically with its nearest dictionary match. In a prescription that could silently change a drug, so here a match is only ever a suggestion.
