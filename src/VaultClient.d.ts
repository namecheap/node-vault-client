export type Lease = {
  getData: () => Record<string, string | Record<string, string>>
}
export type Vault = {
  read: (path: string) => Promise<Lease>
  write: (path: string, data: any) => Promise<any>
  list: (path: string) => Promise<Lease>
}

type VaultClient = {
  boot: (name: string, options: any) => Vault
}

export default VaultClient
