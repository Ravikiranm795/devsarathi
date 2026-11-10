---
paths: {{stackGlobs}}
---
# React rules

- Use function components and hooks; do not add class components. <!-- strict topic:components -->
- Follow the Rules of Hooks; list every dependency in `useEffect`/`useMemo`/`useCallback`. <!-- strict topic:hooks -->
- Do not use `dangerouslySetInnerHTML` without a spec reason and sanitization. <!-- strict topic:xss -->
- Keep data fetching in hooks or the existing data layer, not in presentational components. <!-- default topic:layering -->
- Give list items stable keys; never use the array index when the list can reorder. <!-- default topic:keys -->
- Co-locate tests as `*.test.tsx` and test behavior through the rendered output. <!-- default topic:test-location -->
