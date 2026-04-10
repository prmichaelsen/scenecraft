# Task 20: OpenAPI Spec Migration

**Milestone**: Unassigned  
**Design Reference**: [AI Assistant Chat — Future Considerations](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 16-20 hours  
**Dependencies**: None  
**Status**: Not Started  

---

## Objective

Define the beatlab REST API as `openapi.yaml` and auto-generate TypeScript frontend types, Claude tool definitions, Python request/response validation, and API documentation from the single spec.

---

## Notes

This eliminates manual maintenance of:
- `beatlab-client.ts`, `version-client.ts`, `timeline-client.ts`, `settings-client.ts`, `checkpoint-client.ts`, `workspace-client.ts`
- Claude tool definition lists in the chat backend
- Ad-hoc request validation in `api_server.py`

50+ endpoints in `api_server.py` need to be documented. Could be its own milestone.

---

**Next Task**: None  
