export = VaultClient;

declare class VaultClient {
    constructor(options: VaultClient.VaultOptions);

    static boot(name: string, options: VaultClient.VaultOptions): VaultClient;
    static get(name: string): VaultClient;
    static clear(name?: string): void;

    read(path: string): Promise<VaultClient.Lease>;
    list(path: string): Promise<VaultClient.Lease>;
    write(path: string, data: Record<string, any>): Promise<any>;
    delete(path: string): Promise<any>;
    update(path: string, data: Record<string, any>): Promise<any>;
    request(method: string, path: string, data?: Record<string, any>): Promise<any>;

    deleteVersions(path: string, versions: number[]): Promise<any>;
    undeleteVersions(path: string, versions: number[]): Promise<any>;
    destroyVersions(path: string, versions: number[]): Promise<any>;
    readMetadata(path: string): Promise<any>;
    deleteMetadata(path: string): Promise<any>;

    fillNodeConfig(): Promise<any>;
    getHeaders(token: VaultClient.AuthToken): Record<string, string>;
    close(): void;
}

declare namespace VaultClient {
    interface Logger {
        error(...args: any[]): void;
        warn(...args: any[]): void;
        info(...args: any[]): void;
        debug(...args: any[]): void;
        trace(...args: any[]): void;
    }

    interface ApiConfig {
        url: string;
        apiVersion?: string;
        namespace?: string;
        requestOptions?: Record<string, any>;
        kv?: { autoDetect?: boolean };
        engines?: Record<string, 1 | 2>;
    }

    interface AWSCredentials {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
    }

    interface TokenAuthConfig {
        token: string;
        namespace?: string;
    }

    interface AppRoleAuthConfig {
        role_id: string;
        secret_id?: string;
        namespace?: string;
    }

    interface IAMAuthConfig {
        role: string;
        credentials?: AWSCredentials;
        iam_server_id_header_value?: string;
        region?: string;
        namespace?: string;
    }

    interface KubernetesAuthConfig {
        role: string;
        tokenPath?: string;
        namespace?: string;
    }

    interface JwtAuthConfigCommon {
        role?: string;
        namespace?: string;
    }

    type JwtDistributedClaimConfig =
        | { distributedClaimAccessToken?: never; distributedClaimAccessTokenProvider?: never }
        | { distributedClaimAccessToken: string; distributedClaimAccessTokenProvider?: never }
        | { distributedClaimAccessTokenProvider: () => string | Promise<string>; distributedClaimAccessToken?: never };

    type JwtAuthConfig = JwtAuthConfigCommon &
        (
            | { jwt: string; jwtPath?: never; jwtProvider?: never }
            | { jwtPath: string; jwt?: never; jwtProvider?: never }
            | { jwtProvider: () => string | Promise<string>; jwt?: never; jwtPath?: never }
        ) &
        JwtDistributedClaimConfig;

    interface AuthOptionsCommon {
        mount?: string;
        renewal?: boolean;
        renewalFraction?: number;
        renewalIncrement?: number;
    }

    type AuthOptions = AuthOptionsCommon &
        (
            | { type: 'token'; config: TokenAuthConfig }
            | { type: 'appRole'; config: AppRoleAuthConfig }
            | { type: 'iam'; config: IAMAuthConfig }
            | { type: 'kubernetes'; config: KubernetesAuthConfig }
            | { type: 'jwt'; config: JwtAuthConfig }
        );

    interface VaultOptions {
        api: ApiConfig;
        auth: AuthOptions;
        logger?: Partial<Logger> | false;
    }

    interface Lease {
        getValue<T = any>(key: string): T;
        getData<T = Record<string, any>>(): T;
        isRenewable(): boolean;
        getMetadata(): Record<string, any> | undefined;
    }

    interface AuthToken {
        getId(): string;
        getAccessor(): string;
        isExpired(): boolean;
        isRenewable(): boolean;
        getExpiresAt(): number | null;
    }
}
