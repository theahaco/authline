import { Layout } from "@stellar/design-system"
import styles from "./App.module.css"
import { AuthorizeTrustline } from "./components/AuthorizeTrustline"
import ConnectAccount from "./components/ConnectAccount"

function App() {
	return (
		<div className={styles.AppLayout}>
			<Layout.Header
				projectId="EURCV Auth"
				projectTitle="EURCV Auth"
				projectLink="https://theaha.co"
				hasThemeSwitch={true}
				contentRight={<ConnectAccount />}
			/>

			<main>
				<Layout.Content>
					<Layout.Inset>
						<AuthorizeTrustline />
					</Layout.Inset>
				</Layout.Content>
			</main>

			<Layout.Footer>
				<a
					href="https://theaha.co"
					target="_blank"
					rel="noopener noreferrer"
					className={styles.BuiltBy}
				>
					<span>Built by</span>
					<img src="./logo.svg" alt="The Aha Company" height={80} />
					<span>The Aha Company</span>
				</a>
			</Layout.Footer>
		</div>
	)
}

export default App
