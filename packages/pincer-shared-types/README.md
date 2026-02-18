# @pincer/shared-types

Shared auth helpers and adapter manifest validation utilities for Pincer.

## Exports

- `@pincer/shared-types`
  - Runtime signing helpers (`sha256Hex`, `hmacSha256Hex`, `verifySignedRequest`, etc.)
  - Manifest validation and input schema checks (`validateAdapterManifest`, `validateInputWithSchema`)

## Usage

```ts
import { validateAdapterManifest } from "@pincer/shared-types";

const result = validateAdapterManifest(rawManifest);
if (result.ok === false) {
  console.error(result.errors);
}
```
