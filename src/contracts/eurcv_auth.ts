import * as Client from "eurcv_auth"
import { rpcUrl } from "./util"

export default new Client.Client({
	networkPassphrase: "Public Global Stellar Network ; September 2015",
	contractId: "CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3",
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
