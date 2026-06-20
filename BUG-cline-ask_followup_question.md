# Bug: `ask_followup_question` renders `a.includes is not a function` instead of option buttons

## Environment
- Cline VS Code extension (latest)
- OS: Windows 11
- Auto-approve toggles: Read (all), Edit (all), Safe Commands, Browser, MCP — all ON
- Reporter: user of `whatsapp-agent` workspace; reproduced live in the same session by the model itself

## Summary
When the model calls `ask_followup_question`, the question card renders in the Cline side panel, but instead of showing the clickable option buttons it shows a red inline error:

```
Error executing ask_followup_question: a.includes is not a function
```

The user can see the question text, but has no way to click an answer. The user can also type into the main chat input while the question is pending, but those keystrokes are sent to the chat stream and never reach the question — so the question looks "skipped".

There are therefore two related defects in the same code path:

1. **Render bug:** the option-rendering path throws `a.includes is not a function` and shows the raw TypeError inline.
2. **UX bug:** the main chat input is not disabled / wired to the question while a question is pending, so freeform typing silently goes to chat.

## Repro
1. Open Cline in VS Code with auto-approve on for Read / Edit / Safe Commands / Browser / MCP.
2. From a normal user message, have the model call `ask_followup_question` with a question and 2–5 options.
3. The question card renders with the question text and a "Task Completed" badge.
4. Instead of clickable option buttons, a red line appears: `Error executing ask_followup_question: a.includes is not a function`.
5. Alternative repro path: while the question is pending, type a freeform reply into the main chat input and press Enter. The text is submitted as a new user message; the question card is unaffected and no answer is captured.

## Expected
- The option buttons render and the user can click one.
- OR, if `options` is missing/invalid, a freeform text input renders instead.
- The main chat input is visibly disabled / redirected while a question is pending.
- The tool never surfaces a raw JS TypeError to the user.

## Actual
- Red `TypeError: a.includes is not a function` is rendered inline in the question card.
- No options, no input — the user is stuck.
- Chat input remains active and is not routed to the question.

## Likely cause
`options` is being passed as a non-array (likely a JSON string, or `undefined`), and the render code does something like:

```ts
options.includes(...)
```

directly, without a type guard. Same crash explains the lost freeform reply: the question card errored before wiring up its input handler.

## Suggested fix
1. In the `ask_followup_question` handler, normalize `options` to an `Array<string>` before any `.includes` / `.map` / `.length` call. If it comes in as a string, try `JSON.parse`; if it still isn't an array, fall back to a freeform-text modal.
2. Wrap the option-rendering code in `try/catch`; on throw, render a fallback `<input type="text">` and resolve the tool with its value when the user submits.
3. While a question is pending, disable or visually lock the main chat input, with a clear indicator such as "↑ Awaiting answer to question above".
4. Add regression tests for `ask_followup_question` with:
   - `options: undefined`
   - `options: "a,b,c"` (string instead of array)
   - `options: []` (empty array)
   - `options: ["a","b","c","d","e","f"]` (> 5 entries — over the documented limit)
   - Normal 2–4 option call

## Severity
Medium. The model is fully blocked from receiving a structured answer; the user must abandon the modal and fall back to plain chat to unblock the task. No data loss, but the question feature is effectively unusable in this state.

## Workaround for end users
- Don't rely on the option buttons — type the answer as a normal chat message and ignore the broken question card. The model will read the reply on its next turn.
- Disable auto-approve for at least Safe Commands / MCP to reduce the chance of the modal being auto-dismissed.

## Screenshot reference
User-provided screenshot shows: question text at top, user's typed reply ("ok, isnt it a bug to report??"), then the red `Error executing ask_followup_question: a.includes is not a function` line, then a green "Task Completed" badge — with no option buttons anywhere in the card.
