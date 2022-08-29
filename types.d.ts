declare module 'fetch-extra'

type Resource = RequestInfo
type FetchResponse = Response & {
	completed: Promise<FetchStats>
}
type RetryResponse =
	| {
			resource?: Resource
			options?: FetchOptions
	  }
	| boolean
type RetryDef =
	| number
	| ((params: RetryFnParams) => Promise<RetryResponse> | RetryResponse)
declare class FetchState {
	id: number | string
	resource: Resource
	options: FetchOptions
	userSignal?: AbortSignal
	retry?: RetryDef
	attempt: number
	completed: Promise<FetchStats>
	startTs?: number
	bodyTs?: number
	size?: number
}
type FetchStats = {
	size: number
	duration: number
	attempts: number
	speed: number
}
type RetryFnParams = {
	state: FetchState
	error?: Error
	response?: FetchResponse
}
type ValidateFn = (data: any, state: FetchState) => Promise<void> | void
type FetchOptions = RequestInit & {
	retry?: RetryDef
	timeout?: number
	timeouts?: {
		overall?: number
		request?: number
		stall?: number
		body?: number
	}
	validate?:
		| true
		| ValidateFn
		| {
				response?: boolean | ValidateFn
				buffer?: ValidateFn
				blob?: ValidateFn
				arrayBuffer?: ValidateFn
				json?: ValidateFn
				text?: ValidateFn
				textConverted?: ValidateFn
		  }
	signal?: AbortSignal
	// import doesn't work
	// limiter?: ReturnType<import('async-sema').RateLimit>
	limiter?: () => Promise<void>
}
