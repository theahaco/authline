export interface PopularAsset {
	code: string
	issuer: string
	name: string
	domain?: string
	requiresAuth?: boolean
}

export const popularAssets: PopularAsset[] = [
	{
		code: "USDC",
		issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
		name: "USD Coin",
		domain: "centre.io",
	},
	{
		code: "EURCV",
		issuer: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
		name: "EURCV",
		domain: "sgforge.com",
		requiresAuth: true,
	},
	{
		code: "AQUA",
		issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
		name: "Aquarius",
		domain: "aqua.network",
	},
	{
		code: "yXLM",
		issuer: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55",
		name: "Yield XLM",
		domain: "ultrastellar.com",
	},
	{
		code: "yUSDC",
		issuer: "GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF",
		name: "Yield USDC",
		domain: "ultrastellar.com",
	},
	{
		code: "SHX",
		issuer: "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEZ6IRX17HGDVDHLP5LIR5RG",
		name: "Stronghold",
		domain: "stronghold.co",
	},
	{
		code: "FIDR",
		issuer: "GBZQNUAGO4DZFWOHJ3PVXZKZ2LTSOVAMCTVM46OEMWNWTED4DFS2THCP",
		name: "Fider Token",
		domain: "fider.io",
	},
	{
		code: "BTC",
		issuer: "GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM",
		name: "Bitcoin",
		domain: "ultrastellar.com",
	},
	{
		code: "ETH",
		issuer: "GBFXOHVAS43OIWNIO7XLRJAHT3BICFEIKOJLZVXNT572MISM4CMGSOCC",
		name: "Ethereum",
		domain: "ultrastellar.com",
	},
]

export function assetKey(code: string, issuer: string): string {
	return `${code}:${issuer}`
}
