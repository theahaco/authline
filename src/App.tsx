import { Layout } from "@stellar/design-system"
import { useState } from "react"
import styles from "./App.module.css"
import { AboutPage } from "./components/AboutPage"
import ConnectAccount from "./components/ConnectAccount"
import { Dashboard } from "./components/Dashboard"

function App() {
	const [page, setPage] = useState<"main" | "about">("main")

	return (
		<div className={styles.AppLayout}>
			<Layout.Header
				projectId="Stellar Assets"
				projectTitle="Stellar Assets"
				hasThemeSwitch={true}
				contentRight={<ConnectAccount />}
			/>

			<main>
				<Layout.Content>
					<Layout.Inset>
						{page === "about" ? (
							<AboutPage onBack={() => setPage("main")} />
						) : (
							<Dashboard onShowAbout={() => setPage("about")} />
						)}
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
					<img
						src="./logo.svg"
						alt="The Aha Company"
						className={styles.BuiltByLogo}
					/>
					<span>The Aha Company</span>
				</a>
			</Layout.Footer>
		</div>
	)
}

export default App
