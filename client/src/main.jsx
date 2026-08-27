import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import "./styles.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <Toaster
        position="top-right"
        richColors
        closeButton
        toastOptions={{
          duration: 4000,
          style: {
            fontFamily: "Inter, sans-serif",
            fontSize: "14px",
            borderRadius: "10px",
          },
        }}
      />
      <App />
    </BrowserRouter>
  </StrictMode>
);
