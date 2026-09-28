# Data Fetching

Client-side by default. Uses oRPC + TanStack Query, which gives you:
- Types inferred directly from the server router (no codegen).
- Automatic parallelization when multiple `useQuery` calls live in one component.
- Caching, refetch-on-focus, retry, dedup — all stock React Query behavior.

The only exception is SEO-critical content — see [ssr-for-articles.md](./ssr-for-articles.md).

## Setup (already done)

The `orpc` object is created once in `apps/web/src/utils/orpc.ts` with the CSRF, batch, dedupe, and retry plugins pre-wired. Import from anywhere:

```ts
import { orpc } from "@/utils/orpc";
```

## Batching and the batch size limit

When several `useQuery` calls fire in the same tick, the client's `BatchLinkPlugin` packs them into one `POST /rpc/<procedure>/__batch__` request, and the server's `BatchHandlerPlugin` unpacks it. Both read a single shared constant:

```ts
// packages/config/src/orpc-batch.ts
export const ORPC_BATCH_MAX_SIZE = 10;
```

**To change the cap, change that constant only — never hardcode a different number on one side.** The two limits are not symmetric in effect: on the client `maxSize` is a *splitting* threshold (an oversized batch is recursively halved), while on the server it is a *rejection* threshold. So a client value above the server's does not degrade gracefully — the server answers the entire batch with HTTP 413 and every query in it fails together.

### Debugging a 413 on `/rpc/.../__batch__`

This is the single most misdiagnosed error on this stack. If you see:

```
POST /rpc/listEndpoints/__batch__  →  413
Batch request size exceeds the maximum allowed size
```

- It is a **procedure-count** limit, not a payload-size limit.
- It is **not** Hono's `bodyLimit` (10 MB — that one returns a JSON body, not this plain-text string).
- It is **not** your reverse proxy. Do not raise `client_max_body_size` in nginx/Traefik to chase this.
- The path is a **red herring**: the batch URL is built from the *first* procedure in the batch, so the named procedure is rarely the problem — every query batched alongside it failed too.

The fix is always to reconcile the client and server `maxSize` via the shared constant.

## Basic query

```tsx
import { useQuery } from "@tanstack/react-query";
import { QueryBoundary } from "@/components/query-boundary";
import { orpc } from "@/utils/orpc";

function Dashboard() {
  const settings = useQuery(orpc.settings.getAll.queryOptions());

  return (
    <QueryBoundary
      query={settings}
      skeleton={<DashboardSkeleton />}
      errorMessage="Failed to load dashboard."
    >
      {(data) => <DashboardView data={data} />}
    </QueryBoundary>
  );
}
```

**Every query handles all three states** — pending, error, success. Skip any and you ship a silent failure. Prefer `QueryBoundary` over a hand-rolled `if (isPending)` / `if (isError)` chain; see [loading-and-errors.md](./loading-and-errors.md).

Use `isPending` (not `isLoading`) for the first load state. `isPending` is `true` when there's no data yet; `isLoading` is `true` whenever a fetch is in flight, including background refetches.

## Query with input

```tsx
const post = useQuery(
  orpc.posts.get.queryOptions({
    input: { id: postId },
  }),
);
```

## Conditional query — `skipToken`

Gate the fetch on data being present *without* breaking the rules of hooks:

```tsx
import { skipToken } from "@tanstack/react-query";

const post = useQuery(
  orpc.posts.get.queryOptions({
    input: postId ? { id: postId } : skipToken,
  }),
);
```

Never wrap `useQuery` in an `if` or put it below an early return. Use `skipToken` instead.

## Parallel queries

Multiple `useQuery` calls in the same component fire in parallel automatically — no coordination needed.

```tsx
function Dashboard() {
  const settings = useQuery(orpc.settings.getAll.queryOptions());
  const privateData = useQuery(orpc.privateData.queryOptions());

  const isPending = settings.isPending || privateData.isPending;
  const isError = settings.isError || privateData.isError;

  if (isPending) return <DashboardSkeleton />;
  if (isError) return <ErrorRetry onRetry={() => {
    settings.refetch();
    privateData.refetch();
  }} />;

  return <DashboardView settings={settings.data} privateData={privateData.data} />;
}
```

## Infinite queries

**Default for lists:** `.infiniteOptions()` + `<LoadMore>` (`apps/web/src/components/load-more.tsx`). A flat `limit:` is the exception for a genuinely bounded widget (a "recent 5" card, a combobox page).

```tsx
import { useInfiniteQuery } from "@tanstack/react-query";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { SkeletonList } from "@/components/skeleton-list";
import { orpc } from "@/utils/orpc";

const posts = useInfiniteQuery(
  orpc.posts.list.infiniteOptions({
    input: (cursor: string | undefined) => ({ limit: 20, cursor }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  }),
);

<QueryBoundary query={posts} skeleton={<SkeletonList count={5} />}>
  {(data) => (
    <>
      <ul>{data.pages.flatMap((page) => page.items).map((post) => <li key={post.id}>{post.title}</li>)}</ul>
      <LoadMore
        hasNextPage={posts.hasNextPage}
        isFetchingNextPage={posts.isFetchingNextPage}
        onLoadMore={() => void posts.fetchNextPage()}
      />
    </>
  )}
</QueryBoundary>
```

The `input` is a **function** receiving the current `pageParam`. Offset-paginated admin tables use the same pattern: `initialPageParam: 0` and `getNextPageParam` returning the next offset or `undefined`.

### Server side: the cursor is a composite keyset

The token the client passes back is opaque to it — but on the server it must be a
**value** comparison, never a row identity.

**Never use Prisma's `cursor: { id }` / `skip: 1` for a paged read.** Prisma's
cursor requires that exact row to still exist. Delete the row that happened to
anchor page 1 — a chat session, a post, an asset — and the follow-up query
matches nothing: "Load more" returns an empty page and the list silently ends
early, with no error anywhere. Ids are `cuid(2)` and not sortable, so `id`
alone is not a usable ordering key either.

Use the helpers in `packages/api/src/lib/pagination.ts`:

```ts
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";

list: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
  const items = await prisma.post.findMany({
    // `withCursor` keeps the caller's scope as the first `AND` member, so a
    // cursor can never widen an ownership or visibility filter.
    where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
    // A TOTAL order: the `id` tie-breaker is required. Without it, rows sharing
    // a timestamp repeat or vanish across pages.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageTake(input.limit),
    select: postSelect,
  });
  const page = cursorPage(items, input.limit, "createdAt");
  return { items: page.items.map(serializePost), nextCursor: page.nextCursor };
});
```

- `nextCursor` is `base64url("<iso8601>|<id>")` for the last **returned** row.
  Opaque to the client; the shape may change.
- `cursorPageInput.cursor` validates the token's format, so a tampered or
  stale-format cursor is a 400 input error, not a 500 in the handler.
- The sort column must be the one you order by (`updatedAt`, `publishedAt`, …)
  and must be non-null for every row the query can return — filter nulls out in
  `where`.
- If the projection did not already include the sort column, fetch it for the
  cursor and drop it before serializing; adding a column to a `select` is a
  disclosure decision, not a formality.
- Delete-as-you-scan sweeps are the other shape: `forEachPage` + `keysetWhere`
  (`id > lastSeenId`), which stays correct while the visitor deletes rows.
  **Spread `keysetWhere` into the `where`** — it only ever sets `id`, so
  `where: { status: "PENDING", ...keysetWhere(page.afterId) }` is the form every
  caller uses. If your `where` already has an `id` filter, spreading would drop
  one of the two; put both inside an `AND` instead. `forEachPage` throws if a
  page does not start after `afterId`, which is how a forgotten `keysetWhere`
  surfaces on page 2 instead of looping forever.


## Pull-to-refresh

Use the `PullToRefresh` component on data-heavy pages. It wraps content and takes an `onRefresh` callback returning a Promise.

```tsx
import { useQueryClient } from "@tanstack/react-query";
import PullToRefresh from "@/components/pull-to-refresh";

function Page() {
  const queryClient = useQueryClient();
  return (
    <PullToRefresh onRefresh={() => queryClient.invalidateQueries({ queryKey: orpc.settings.key() })}>
      {/* content */}
    </PullToRefresh>
  );
}
```

## What NOT to do

- ❌ **Don't use React Query for autocomplete suggestions.** Use `.call()` directly with an `AbortController`. See [autosuggest.md](./autosuggest.md).
- ❌ **Don't call oRPC procedures from route `loader`s** unless the route is explicitly SSR-for-SEO. Dashboard data should fetch client-side.
- ❌ **Don't silently swallow errors.** If a query fails, show the user.
- ❌ **Don't spin a loader where a skeleton would fit.** Skeletons are calmer and mirror the final layout.
- ❌ **Don't wrap `useQuery` in a condition.** Hooks must run in the same order every render — use `skipToken` to gate.

## Reference

- Client setup: `apps/web/src/utils/orpc.ts`
- Example usage: `apps/web/src/routes/$lang/_app/_auth/dashboard.tsx`
- Example error handling: `apps/web/src/routes/$lang/_app/_auth.tsx`
- Infinite list + LoadMore: `apps/web/src/routes/$lang/_app/admin/users.tsx`, `apps/web/src/routes/$lang/_app/admin/content/posts/index.tsx`
