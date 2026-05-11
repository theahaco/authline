import * as Client from "eurcv_auth"
import { eurcvAuthContractId, networkPassphrase, rpcUrl } from "./util"

export default new Client.Client({
	networkPassphrase,
	contractId: eurcvAuthContractId,
	rpcUrl,
	allowHttp: true,
	publicKey: undefined,
})
