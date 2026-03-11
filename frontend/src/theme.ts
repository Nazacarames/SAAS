import { createTheme } from "@mui/material/styles";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#5BB2FF",
      light: "#8CCBFF",
      dark: "#2D7FCC",
      contrastText: "#08101C"
    },
    secondary: {
      main: "#22D3EE",
      light: "#67E8F9",
      dark: "#0E7490"
    },
    success: { main: "#22C55E" },
    warning: { main: "#F59E0B" },
    error: { main: "#EF4444" },
    background: {
      default: "#070D18",
      paper: "#0C1424"
    },
    text: {
      primary: "#E8EDF7",
      secondary: "#9BA9C3"
    },
    divider: "rgba(125, 157, 214, 0.20)"
  },
  shape: {
    borderRadius: 14
  },
  typography: {
    fontFamily: '"Plus Jakarta Sans", "Inter", "Segoe UI", sans-serif',
    h4: {
      fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif',
      fontWeight: 700,
      letterSpacing: -0.3
    },
    h5: {
      fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif',
      fontWeight: 700,
      letterSpacing: -0.2
    },
    h6: {
      fontFamily: '"Space Grotesk", "Plus Jakarta Sans", sans-serif',
      fontWeight: 700
    },
    button: {
      fontWeight: 600,
      letterSpacing: 0.1
    }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          background:
            "radial-gradient(circle at 12% 18%, rgba(91,178,255,0.10) 0%, rgba(7,13,24,0) 30%), radial-gradient(circle at 88% 0%, rgba(34,211,238,0.10) 0%, rgba(7,13,24,0) 28%), #070D18"
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "rgba(12,20,36,0.88)",
          backdropFilter: "blur(10px)",
          border: "1px solid rgba(125,157,214,0.18)",
          boxShadow: "0 10px 28px rgba(4,10,20,0.35)"
        }
      }
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid rgba(125,157,214,0.16)",
          boxShadow: "0 8px 22px rgba(4,10,20,0.30)",
          transition: "transform .18s ease, box-shadow .18s ease, border-color .18s ease",
          "&:hover": {
            transform: "translateY(-2px)",
            borderColor: "rgba(91,178,255,0.34)",
            boxShadow: "0 14px 28px rgba(4,10,20,0.42)"
          }
        }
      }
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: "linear-gradient(180deg, rgba(12,20,36,0.95) 0%, rgba(7,13,24,0.90) 100%)",
          borderBottom: "1px solid rgba(125,157,214,0.20)",
          backdropFilter: "blur(8px)",
          color: "#E8EDF7"
        }
      }
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          background: "linear-gradient(180deg, #0A1222 0%, #08101C 100%)",
          borderRight: "1px solid rgba(125,157,214,0.16)",
          color: "#E8EDF7"
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          margin: "2px 8px",
          transition: "all .18s ease",
          "&.Mui-selected": {
            backgroundColor: "rgba(91,178,255,0.18)",
            border: "1px solid rgba(91,178,255,0.32)",
            "&:hover": {
              backgroundColor: "rgba(91,178,255,0.25)"
            }
          },
          "&:hover": {
            transform: "translateX(2px)",
            backgroundColor: "rgba(255,255,255,0.06)"
          }
        }
      }
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          "& .MuiTableCell-head": {
            color: "#B9C8E0",
            fontWeight: 700,
            letterSpacing: 0.2,
            backgroundColor: "rgba(91,178,255,0.06)",
            borderBottom: "1px solid rgba(125,157,214,0.20)"
          }
        }
      }
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          "&:hover": {
            backgroundColor: "rgba(91,178,255,0.06)"
          }
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          borderRadius: 11
        },
        contained: {
          background: "linear-gradient(180deg, #5BB2FF 0%, #3A8FD8 100%)",
          color: "#08101C",
          boxShadow: "0 8px 20px rgba(16, 95, 173, 0.35)",
          "&:hover": {
            background: "linear-gradient(180deg, #8CCBFF 0%, #5BB2FF 100%)"
          }
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 9,
          fontWeight: 600
        }
      }
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            borderRadius: 11,
            backgroundColor: "rgba(8,14,26,0.72)",
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: "rgba(125,157,214,0.24)"
            },
            "&:hover .MuiOutlinedInput-notchedOutline": {
              borderColor: "rgba(125,157,214,0.42)"
            },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: "#5BB2FF",
              boxShadow: "0 0 0 2px rgba(91,178,255,0.20)"
            }
          }
        }
      }
    }
  }
});

export default theme;
