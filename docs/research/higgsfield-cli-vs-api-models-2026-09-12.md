# Higgsfield CLI vs public API model availability

Date checked: 2026-09-12

## Conclusion

The CLI and public API do not currently have a documented one-to-one model catalog. The CLI exposes a broader and newer account/workspace-scoped live catalog, while the public API publishes a smaller set of image/video families and applies account-specific entitlements. An API key only authenticates an API account; it does not grant the CLI catalog automatically.

For this project, the exact configured CLI models are not present in the current public OpenAPI specification:

- `gpt_image_2`: available in the CLI catalog; no documented public API endpoint.
- `seedance_2_0`: available in the CLI catalog; the public API specification currently documents Seedance v1 endpoints, not Seedance 2.0.

Therefore, replacing the CLI adapter entirely with the public API would currently lose exact model parity for this workflow. A hybrid provider adapter is the safest architecture if API-key automation is desired.

## Evidence

| Surface | Published/live availability | Interpretation |
| --- | --- | --- |
| CLI v1.1.24 release catalog | 23 image, 22 video, 5 3D, and 5 audio job types | 55 job types across four media categories. |
| CLI live catalog checked with v1.1.24 | 32 image and 35 video job types for the checked account/workspace | The server-driven catalog can be newer and broader than the release README. |
| Public API OpenAPI v2.0 | 48 generation routes grouped under 13 tags/families; image and video only | Routes include workflow/tier variants, so 48 endpoints must not be compared directly with 55 CLI job types. |

The public API specification includes families such as DOP, Soul, Veo 3.1, Seedance v1, Flux Kontext, Kling 2.1/2.5, Minimax Hailuo, Nano Banana, Reve, Sora 2, and Wan 2.5. It does not document many newer CLI entries, including GPT Image 2/2.5 and Seedance 2.0/2.5.

Higgsfield's authentication documentation says individual models may have separate access restrictions, and its FAQ says model availability depends on the account. Consequently, the Cloud dashboard and a real request using the intended organization are authoritative for entitlement; public documentation alone cannot guarantee access.

## Architectural implication

Keep API credentials only on the backend. If both automation and maximum catalog coverage are needed, expose one backend generation interface with two server-side adapters:

1. Public API adapter for endpoints available to the API organization.
2. CLI adapter for CLI-only models, using the CLI's own OAuth credentials.

The backend should report provider capabilities to the frontend so users can only select models available through the active provider. Do not send API keys, CLI refresh tokens, or credential files to the browser.

## Primary sources

- [Higgsfield CLI v1.1.24 release](https://github.com/higgsfield-ai/cli/releases/tag/v1.1.24)
- [Higgsfield CLI v1.1.24 model catalog](https://github.com/higgsfield-ai/cli/blob/v1.1.24/README.md#models)
- [Higgsfield CLI live-model documentation](https://github.com/higgsfield-ai/cli/blob/main/MODELS.md)
- [Higgsfield public OpenAPI specification](https://docs.higgsfield.ai/docs/openapi.json)
- [Higgsfield API authentication](https://docs.higgsfield.ai/docs/authentication.md)
- [Higgsfield API FAQ](https://docs.higgsfield.ai/docs/help/faq.md)
