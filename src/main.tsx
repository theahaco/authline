import React from "react"
import { createRoot } from "react-dom/client"
import "./authline.css"
import { AuthlineApp } from "./authline.js"

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<AuthlineApp />
	</React.StrictMode>,
)
