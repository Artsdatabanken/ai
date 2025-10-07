# Warnings Configuration

The warnings system allows you to configure contextual warnings that are displayed with species identification results based on various criteria.

## Configuration File

Warnings are configured in `config/warnings.json` as an array of warning objects.

## Warning Types

### General Warnings (`"type": "general"`)
Applied to the overall result if any prediction matches the conditions. Appears once in the `warnings.general` array, even if multiple predictions match.

### Prediction Warnings (`"type": "prediction"`)
Applied to individual predictions that match the conditions. Appears in `warnings.predictions[index]` for each matching prediction.

## Warning Structure

```json
{
  "id": "unique-identifier",
  "type": "general" | "prediction",
  "category": "info" | "warning" | "danger",
  "conditions": { /* see conditions below */ },
  "title": {
    "nb": "Norwegian title",
    "nn": "Nynorsk title",
    "en": "English title",
    "sv": "Swedish title",
    "se": "Sami title",
    "nl": "Dutch title",
    "es": "Spanish title"
  },
  "message": {
    "nb": "Norwegian message",
    "nn": "Nynorsk message",
    "en": "English message",
    "sv": "Swedish message",
    "se": "Sami message",
    "nl": "Dutch message",
    "es": "Spanish message"
  },
  "link": {
    "nb": "https://...",
    "en": "https://...",
    /* optional, per language */
  }
}
```

### Fields

- **id**: Unique identifier for the warning
- **type**: Either "general" (applies to overall result) or "prediction" (applies to individual predictions)
- **category**: Severity level - "info", "warning", or "danger" (defaults to "info" if not specified)
- **conditions**: Object defining when this warning should appear (see Conditions section)
- **title**: Multilingual title object
- **message**: Multilingual message object
- **link**: Optional multilingual link object

## Conditions

All conditions are optional. If multiple conditions are specified, ALL must match (AND logic).

### `groupNames`
Match against the Norwegian group name (e.g., "sopper", "fugler").

```json
"groupNames": ["sopper"]
```

### `scientificName`
Match against the scientific name. Can be:
- Single name: `"scientificName": "Amanita muscaria"`
- Array of names: `"scientificName": ["Amanita muscaria", "Amanita pantherina"]`

```json
"scientificName": ["Amanita muscaria", "Amanita pantherina"]
```

### `country`
Match against the ISO country code (e.g., "NO", "SE").

```json
"country": "NO"
```

### `invasiveCategory`
Match against invasive species category. Can be:
- Exact match: `"invasiveCategory": "SE"`
- Array of values: `"invasiveCategory": ["SE", "HI"]`
- Range: `"invasiveCategory": {"min": "HI", "max": "SE"}`

```json
"invasiveCategory": "SE"
```

### `redListCategory`
Match against red list category (e.g., "CR", "EN", "VU"). Same matching options as invasiveCategory.

```json
"redListCategory": ["CR", "EN"]
```

### `lat` / `lon`
Match against latitude/longitude. Can be:
- Exact match: `"lat": 68.5`
- Minimum: `"lat": {"min": 68}`
- Maximum: `"lat": {"max": 70}`
- Range: `"lat": {"min": 68, "max": 70}`

```json
"lat": {
  "min": 68
}
```

### `date`
Match against observation date. Format: `MM-DD` (month-day).
- `after`: Date must be after this date (exclusive)
- `before`: Date must be before this date (exclusive)

```json
"date": {
  "after": "05-01",
  "before": "09-30"
}
```

Note: Year is ignored; only month and day are compared.

### `certainty`
Match against prediction probability (0-1). Can be:
- Exact: `"certainty": 0.8`
- Minimum: `"certainty": {"min": 0.5}`
- Maximum: `"certainty": {"max": 0.9}`
- Range: `"certainty": {"min": 0.5, "max": 0.9}`

```json
"certainty": {
  "min": 0.5
}
```

## Example Configurations

### General Warning for All Fungi
```json
{
  "id": "fungi-general",
  "type": "general",
  "category": "warning",
  "conditions": {
    "groupNames": ["sopper"]
  },
  "title": {
    "en": "Fungi Identification"
  },
  "message": {
    "en": "Fungi can be difficult to identify from images alone. We recommend consulting an expert before collecting."
  },
  "link": {
    "en": "https://www.artsdatabanken.no/fungi"
  }
}
```

### Prediction Warning for Rare Species
```json
{
  "id": "rare-species",
  "type": "prediction",
  "category": "danger",
  "conditions": {
    "redListCategory": ["CR", "EN"],
    "certainty": {
      "max": 0.7
    }
  },
  "title": {
    "en": "Rare Species"
  },
  "message": {
    "en": "This is a rare species. Please verify the identification carefully."
  }
}
```

### Location and Time-Based Warning
```json
{
  "id": "northern-early-season",
  "type": "prediction",
  "category": "info",
  "conditions": {
    "country": "NO",
    "lat": {
      "min": 68
    },
    "date": {
      "after": "05-01"
    },
    "certainty": {
      "min": 0.5
    }
  },
  "title": {
    "en": "Early in Season"
  },
  "message": {
    "en": "This is early in the season for Northern Norway observations."
  }
}
```

## Response Format

Warnings are added to the response as:

```json
{
  "warnings": {
    "general": [
      {
        "category": "warning",
        "title": {
          "nb": "Sopp-identifikasjon",
          "en": "Fungi Identification",
          ...
        },
        "message": {
          "nb": "Sopper kan være vanskelige...",
          "en": "Fungi can be difficult...",
          ...
        },
        "link": {
          "nb": "https://...",
          "en": "https://...",
          ...
        }
      }
    ],
    "predictions": {
      "0": [
        {
          "category": "info",
          "title": {
            "nb": "Tidlig på sesongen",
            "en": "Early in Season",
            ...
          },
          "message": {
            "nb": "Dette er tidlig...",
            "en": "This is early...",
            ...
          }
        }
      ],
      "2": [
        {
          "category": "danger",
          "title": { ... },
          "message": { ... }
        }
      ]
    }
  }
}
```

The `warnings` object is only included if there are warnings to display. All text fields (title, message, link) are returned as multilingual objects containing all available languages.

## Implementation Details

- All warnings are returned with full multilingual support (title, message, and link objects)
- The client application is responsible for selecting the appropriate language to display
- Links are optional and language-specific
- Category defaults to "info" if not specified
- Date comparisons ignore the year (only month/day matter)
- Latitude/longitude come from request coordinates or are undefined
- Country is determined from coordinates or IP address
- If no date is provided in the request, today's date is used
