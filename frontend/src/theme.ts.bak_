import { createTheme } from "@mui/material/styles";

// Dark theme inspired by the provided dashboard palette
// Base: deep navy backgrounds + soft borders + blue/cyan accents
const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#3FA7FF", // accent blue
      light: "#78C4FF",
      dark: "#1E6FB8",
      contrastText: "#0B1220"
    },
    secondary: {
      main: "#22D3EE", // cyan
      light: "#67E8F9",
      dark: "#0891B2"
    },
    background: {
      default: "#0B1220",
      paper: "#0F172A"
    },
    text: {
      primary: "#E5E7EB",
      secondary: "#9CA3AF"
    },
    divider: "#1F2A44"
  },
  shape: {
    borderRadius: 14
  },
  typography: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"',
    h6: {
      fontWeight: 700
    }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: "#0B1220"
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          border: "1px solid #17223B"
        }
      }
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: "linear-gradient(180deg, #0F172A 0%, #0B1220 100%)",
          borderBottom: "1px solid #17223B",
          color: "#E5E7EB"
        }
      }
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: "#0B1220",
          borderRight: "1px solid #17223B",
          color: "#E5E7EB"
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          margin: "2px 8px",
          "&.Mui-selected": {
            backgroundColor: "rgba(63, 167, 255, 0.16)",
            "&:hover": {
              backgroundColor: "rgba(63, 167, 255, 0.22)"
            }
          },
          "&:hover": {
            backgroundColor: "rgba(255,255,255,0.06)"
          }
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          borderRadius: 12
        },
        contained: {
          background: "linear-gradient(180deg, #3FA7FF 0%, #2B7BD0 100%)",
          color: "#0B1220",
          boxShadow: "0 10px 20px rgba(0,0,0,0.35)",
          "&:hover": {
            background: "linear-gradient(180deg, #78C4FF 0%, #3FA7FF 100%)"
          }
        },
        outlined: {
          borderColor: "#1F2A44"
        }
      }
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: "#1F2A44"
          }
        }
      }
    }
  }
});

export default theme;
