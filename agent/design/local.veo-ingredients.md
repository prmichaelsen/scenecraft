# Veo Ingredients & Advanced Generation Parameters

**Concept**: Support Veo reference image ingredients, negative prompts, seed control, and video extension for transition video generation
**Created**: 2026-04-15
**Status**: Design Specification

---

## Overview

Extends the transition video generation pipeline to leverage additional Veo API capabilities: reference images ("ingredients") for character/object consistency, negative prompts to avoid unwanted content, seed control for reproducible generation, and video extension to grow existing clips.

## Frontend Changes (Implemented)

### New Transition Fields
- `ingredients: string[]` — paths to ingredient images (max 3)
- `negativePrompt: string` — content to avoid in generation
- `seed: number | null` — optional uint32 for reproducibility

### New API Client Functions (scenecraft-client.ts)
- `fetchIngredients(project)` → GET `/ingredients`
- `postPromoteToIngredient(project, sourceType, sourcePath, label?)` → POST `/ingredients/promote`
- `postRemoveIngredient(project, ingredientId)` → POST `/ingredients/remove`
- `postUpdateIngredientLabel(project, ingredientId, label)` → POST `/ingredients/update`
- `postExtendVideo(project, transitionId, videoPath)` → POST `/extend-video`

### Updated API Client Signatures
- `postGenerateTransitionCandidates` — added `ingredients`, `negativePrompt`, `seed` params
- `postUpdateTransitionAction` — added `negativePrompt`, `seed`, `ingredients` params

### UI
- **TransitionPanel CandidatesTab**: Ingredients row (thumbnails + picker), negative prompt input, seed input with randomize, "+7s" extend button on video cards
- **BinPanel**: New "Ingr" tab with ingredient grid, promote-from-keyframe and promote-from-pool workflows

---

## Backend API Spec (for scenecraft-engine)

### New Endpoints

#### GET `/api/projects/{project}/ingredients`
Returns all ingredients for a project.

**Response:**
```json
{
  "ingredients": [
    {
      "id": "ing_a1b2c3",
      "path": "ingredients/ing_a1b2c3.png",
      "label": "Main character",
      "addedAt": "2026-04-15T12:00:00Z",
      "sourceType": "keyframe",
      "sourceRef": "kf_abc123"
    }
  ]
}
```

#### POST `/api/projects/{project}/ingredients/promote`
Copies an existing image into the ingredients directory.

**Request:**
```json
{
  "sourceType": "keyframe" | "pool",
  "sourcePath": "selected_keyframes/kf_abc123.png",
  "label": "Main character"
}
```

**Behavior:**
1. Generate a unique ID (e.g., `ing_${nanoid()}`)
2. Copy image from `sourcePath` to `{project}/ingredients/{id}.png`
3. Generate thumbnail at `{project}/thumbnails/ingredients/{id}.jpg`
4. Add entry to `{project}/ingredients.json` manifest
5. Return the new `Ingredient` object

**Response:**
```json
{
  "success": true,
  "ingredient": { "id": "ing_xyz", "path": "ingredients/ing_xyz.png", ... }
}
```

#### POST `/api/projects/{project}/ingredients/remove`
**Request:** `{ "ingredientId": "ing_a1b2c3" }`

**Behavior:**
1. Delete image file from `ingredients/`
2. Delete thumbnail from `thumbnails/ingredients/`
3. Remove entry from `ingredients.json`

#### POST `/api/projects/{project}/ingredients/update`
**Request:** `{ "ingredientId": "ing_a1b2c3", "label": "Updated label" }`

### Updated Endpoints

#### POST `/api/projects/{project}/update-transition-action`
**New optional body fields:**
- `negativePrompt?: string` — persisted on transition record
- `seed?: number | null` — persisted on transition record (null clears)
- `ingredients?: string[]` — persisted on transition record (paths in `ingredients/` dir)

#### POST `/api/projects/{project}/generate-transition-candidates`
**New optional body fields:**
- `ingredients?: string[]` — paths to ingredient images
- `negativePrompt?: string`
- `seed?: number` (uint32)

**Backend behavior for ingredients:**
1. Read each ingredient file from disk
2. Base64-encode each image
3. Send to Veo as `referenceImages` array:
```json
{
  "referenceImages": [
    {
      "image": { "bytesBase64Encoded": "...", "mimeType": "image/png" },
      "referenceType": "asset"
    }
  ]
}
```
4. Map `negativePrompt` → Veo `parameters.negativePrompt`
5. Map `seed` → Veo `parameters.seed`

**Note:** When ingredients are used, Veo 3.1 requires `durationSeconds: "8"`.

#### POST `/api/projects/{project}/extend-video` (NEW)
Extends an existing video clip by ~7 seconds using Veo video extension.

**Request:**
```json
{
  "transitionId": "tr_abc",
  "videoPath": "transition_candidates/tr_abc/slot_0/v1.mp4"
}
```

**Backend behavior:**
1. Read the video file at `videoPath`
2. Base64-encode it
3. Call Veo with the `video` field + the transition's action prompt
4. Save the extended result as a new candidate variant
5. Return async job ID

**Response:** `{ "jobId": "job_123", "transitionId": "tr_abc" }`

### File Storage

```
{project}/
  ingredients/
    ing_a1b2c3.png
    ing_d4e5f6.png
  ingredients.json          # manifest with metadata
  thumbnails/
    ingredients/
      ing_a1b2c3.jpg
      ing_d4e5f6.jpg
```

**ingredients.json format:**
```json
{
  "ingredients": [
    {
      "id": "ing_a1b2c3",
      "path": "ingredients/ing_a1b2c3.png",
      "label": "Main character",
      "addedAt": "2026-04-15T12:00:00Z",
      "sourceType": "keyframe",
      "sourceRef": "kf_abc123"
    }
  ]
}
```

---

**Status**: Design Specification
**Recommendation**: Implement backend endpoints following this spec
