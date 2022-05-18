# Node-fetch wrapper

The goal is to add some extra functionality to node-fetch in a non-intrusive way:

- Extra options:
  - `type FetchResource: Parameters<fetch>[0]`
  - `type FetchState: {retryCount: number, fetchId: string, resource: FetchResource, options: FetchOptions}`
  - `type FetchStats: {ok, error, totalMs, sentMs, receivedMs, sent, received}`
  - `retry: number | ({error: Error, response: Response, state: FetchState}) => Promise<boolean | {resource: FetchResource, options: FetchOptions} (could just return state)>`
    - number is just an easy option to retry with a given number of attempts
    - and function is an interface in which you can make complex rules whether to retry or not
      - returning `true` = retry
      - returning falsy = don't retry, fetch will throw the original `error`
      - returning object = retry with given parameters (allows you to modify request on retry)
      - throwing = don't retry, fetch will throw what you've thrown
  - `validate: true | (response: Omit<Response, "body">, state: FetchState) => Promise<void>`: throws allows to retry the request (with no body consumed yet!) on particular circumstances
    - if `true`, then `validate: res => if (!res.ok ) throw HttpError`
  - `validate.json`, `validate.buffer`, etc - same rule as `validate`, but with access to the parsed body `(result: any, state: FetchState)`
  - `timeout: number`: default value for all the request handling (doing the request + fetching the body); same as in node-fetch v2
  - `requestTimeout` = timeout for `await fetch(...)` (includes body upload time)
  - `bodyTimeout` = timeout for fetching the whole body, i.e. `await res.json()`
  - `stallTimeout` = same as `body`, except instead of fixed time of fetching the whole body, we count the time of download speed of 0 bytes/s
- todo: abort controller we use for timeout handling shouldn't ignore abort controller given in the options (already put the comment in the code)
- todo: `noProgress` but for file upload (request)?
- Extra Response fields:
  - `completed: Promise<FetchStats>`: Promise for body completion - rejects if fetch body or validation failed
- `makeFetch` with built-in async-sema options like Sema and RateLimit
- rich logging: ?
  - request start (include the body if it's string)
  - request done/failed
  - download for larger bodies (maybe with download speed?)
  - retries
  - sema
- tests
- todo: download helper that will hash on fly and have retry support

Helper StatsStream: maybe exists somewhere? re-export or rebuild
