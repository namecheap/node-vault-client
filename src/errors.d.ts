export declare class VaultError extends Error {
    constructor(message: string, options?: { cause?: unknown });
    name: string;
}

export declare class InvalidArgumentsError extends VaultError {}

export declare class InvalidAWSCredentialsError extends InvalidArgumentsError {}

export declare class AuthTokenExpiredError extends VaultError {}

export declare class UnsupportedOperationError extends VaultError {}

export declare class VaultHttpError extends VaultError {
    constructor(statusCode: number, text: string, body?: unknown, headers?: { retryAfter?: string | null });
    statusCode: number;
    error: unknown;
    /** Raw `Retry-After` response header; absent when the response did not send one or it was empty. */
    retryAfter?: string;
    /**
     * `Retry-After` in milliseconds (delay-seconds or HTTP-date), capped at 2147483647;
     * absent when the header was not sent or cannot be parsed.
     */
    retryAfterMs?: number;
}

export declare class RequestTimeoutError extends VaultError {
    constructor(timeout: number, options?: { cause?: unknown });
    timeout: number;
}
