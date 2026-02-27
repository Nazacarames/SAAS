import { Outlet } from 'react-router-dom';
import { Box, Toolbar, AppBar, Typography } from '@mui/material';
import Sidebar from '../components/Sidebar';

const MainLayout = () => {
    return (
        <Box sx={{ display: 'flex' }}>
            <AppBar
                position="fixed"
                sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
            >
                <Toolbar>
                    <Typography variant="h6" noWrap component="div">
                        LMTM CRM - Sistema de Atención WhatsApp
                    </Typography>
                </Toolbar>
            </AppBar>
            <Sidebar />
            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    p: 3,
                    width: { sm: `calc(100% - 240px)` }
                }}
            >
                <Toolbar />
                <Outlet />
            </Box>
        </Box>
    );
};

export default MainLayout;
