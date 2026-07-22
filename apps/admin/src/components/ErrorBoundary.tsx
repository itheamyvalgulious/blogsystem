import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Admin UI render error:", error, info);
  }

  override render() {
    const { error } = this.state;
    if (error) {
      return (
        <div
          role="alert"
          style={{
            alignItems: "center",
            background: "#10151c",
            color: "#d8e1eb",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            height: "100vh",
            justifyContent: "center",
            padding: "32px"
          }}
        >
          <h1 style={{ fontSize: "20px", margin: 0 }}>Something went wrong</h1>
          <pre
            style={{
              background: "#172028",
              border: "1px solid #2a3644",
              borderRadius: "8px",
              margin: 0,
              maxWidth: "720px",
              overflow: "auto",
              padding: "12px 16px",
              whiteSpace: "pre-wrap"
            }}
          >
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#2f6fed",
              border: "none",
              borderRadius: "8px",
              color: "#ffffff",
              cursor: "pointer",
              fontSize: "14px",
              padding: "8px 20px"
            }}
            type="button"
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
