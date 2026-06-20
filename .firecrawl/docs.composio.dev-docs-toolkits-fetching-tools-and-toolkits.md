Toolkits

# Fetching tools and toolkits

Copy page [View Markdown](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits.md) Ask AIFeedback

## [Fetching for a session](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits\#fetching-for-a-session)

When using sessions, fetch tools through the session object.

### [List enabled toolkits](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits\#list-enabled-toolkits)

`session.toolkits()` returns toolkits enabled for your session, sorted by popularity. By default, it returns the top 20. Each toolkit includes its `slug`, `name`, `logo`, and connection status.

PythonTypeScript

```
session = composio.create(user_id="user_123")

result = session.toolkits()

for toolkit in result.items:
    print(f"{toolkit.name}: connected={toolkit.connection.is_active if toolkit.connection else 'n/a'}")
```

```
const session = await composio.create("user_123");

const result = await session.toolkits();

for (const toolkit of result.items) {
  console.log(`${toolkit.name}: connected=${toolkit.connection?.isActive ?? 'n/a'}`);
}
```

You can filter to only show connected toolkits:

PythonTypeScript

```
connected = session.toolkits(is_connected=True)  # Only connected
```

```
const connected = await session.toolkits({ isConnected: true });  // Only connected
```

To fetch all toolkits, paginate through the results:

PythonTypeScript

```
all_toolkits = []
cursor = None

while True:
    result = session.toolkits(limit=20, next_cursor=cursor)
    all_toolkits.extend(result.items)
    cursor = result.next_cursor
    if not cursor:
        break
```

```
const allToolkits: any[] = [];
let cursor: string | undefined;

do {
  const { items, cursor: nextCursor } = await session.toolkits({ limit: 20, cursor });
  allToolkits.push(...items);
  cursor = nextCursor;
} while (cursor);
```

### [Get meta tools](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits\#get-meta-tools)

`session.tools()` returns the [meta tools](https://docs.composio.dev/reference/meta-tools) formatted for your configured provider (OpenAI, Anthropic, etc.):

PythonTypeScript

```
# Get all meta tools
tools = session.tools()
```

```
// Get all meta tools
const tools = await session.tools();
```

To restrict which toolkits or tools are discoverable by the meta tools, configure them when [creating the session](https://docs.composio.dev/docs/toolkits/enable-and-disable-toolkits).

## [Browsing the catalog](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits\#browsing-the-catalog)

Before configuring a session, you may want to explore what toolkits and tools are available. You can browse visually at [platform.composio.dev](https://platform.composio.dev/) or in the [docs](https://docs.composio.dev/toolkits), or fetch programmatically:

PythonTypeScript

```
# List toolkits
toolkits = composio.toolkits.get()

# List tools within a toolkit (top 20 by default)
tools = composio.tools.get("user_123", toolkits=["GITHUB"])
```

```
// List toolkits
const toolkits = await composio.toolkits.get();

// List tools within a toolkit (top 20 by default)
const tools = await composio.tools.get(userId, { toolkits: ["GITHUB"] });
```

### [Get a tool's schema](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits\#get-a-tools-schema)

To inspect a tool's input parameters and types without needing a user context, use `getRawComposioToolBySlug`:

PythonTypeScript

```
tool = composio.tools.get_raw_composio_tool_by_slug("GMAIL_SEND_EMAIL")
print(tool.name)
print(tool.description)
print(tool.input_parameters)
print(tool.output_parameters)
```

```
const tool = await composio.tools.getRawComposioToolBySlug("GMAIL_SEND_EMAIL");
console.log(tool.name);
console.log(tool.description);
console.log(tool.inputParameters);
console.log(tool.outputParameters);
```

## [What to read next](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits\#what-to-read-next)

[**Enable & disable toolkits** \\
Control which toolkits and individual tools are available in sessions](https://docs.composio.dev/docs/toolkits/enable-and-disable-toolkits) [**Tools and toolkits** \\
How meta tools discover, authenticate, and execute tools at runtime](https://docs.composio.dev/docs/tools-and-toolkits) [**Browse toolkits** \\
Explore all available toolkits and their tools](https://docs.composio.dev/toolkits)

### On this page

[Fetching for a session](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits#fetching-for-a-session) [List enabled toolkits](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits#list-enabled-toolkits) [Get meta tools](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits#get-meta-tools) [Browsing the catalog](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits#browsing-the-catalog) [Get a tool's schema](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits#get-a-tools-schema) [What to read next](https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits#what-to-read-next)

 Ask AI

Chat Widget

Loading...