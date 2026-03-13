import * as Sentry from "@sentry/react";
import { Component, ErrorInfo, ReactNode } from "react";
import { Box, Typography, Button } from "@mui/material";

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, error: null };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        Sentry.captureException(error);
        console.error("ErrorBoundary caught:", error, info.componentStack);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <Box
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    minHeight="100vh"
                    gap={2}
                    p={3}
                >
                    <Typography variant="h5">Algo salió mal</Typography>
                    <Typography color="text.secondary" textAlign="center">
                        Ocurrió un error inesperado. Intenta recargar la página.
                    </Typography>
                    <Box display="flex" gap={2}>
                        <Button
                            variant="contained"
                            onClick={() => window.location.reload()}
                        >
                            Recargar página
                        </Button>
                        <Button variant="outlined" onClick={this.handleReset}>
                            Intentar de nuevo
                        </Button>
                    </Box>
                </Box>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
