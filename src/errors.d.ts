export declare class VaultError extends Error {
    constructor(message: string, options?: { cause?: unknown });
    name: string;
}

export declare class InvalidArgumentsError extends VaultError {}

export declare class InvalidAWSCredentialsError extends InvalidArgumentsError {}

export declare class AuthTokenExpiredError extends VaultError {}

export declare class UnsupportedOperationError extends VaultError {}

export declare class VaultHttpError extends VaultError {
    constructor(statusCode: number, text: string, body?: unknown);
    statusCode: number;
    error: unknown;
}
