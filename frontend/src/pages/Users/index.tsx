import { useEffect, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

interface User {
  id: number;
  name: string;
  email: string;
  profile: string;
  createdAt?: string;
}

const Users = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState<'admin' | 'user'>('user');

  const fetchUsers = async () => {
    try {
      const { data } = await api.get('/users');
      setUsers(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching users:', error);
      toast.error('Error al cargar usuarios');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const resetForm = () => {
    setName('');
    setEmail('');
    setPassword('');
    setProfile('user');
  };

  const handleOpen = () => {
    resetForm();
    setOpen(true);
  };

  const handleClose = () => {
    if (!creating) setOpen(false);
  };

  const handleCreate = async () => {
    if (!name.trim() || !email.trim() || !password.trim()) {
      toast.error('Completa nombre, email y contraseña');
      return;
    }

    setCreating(true);
    try {
      await api.post('/users', { name, email, password, profile });
      toast.success('Usuario creado');
      setOpen(false);
      fetchUsers();
    } catch (error: any) {
      console.error('Error creating user:', error);
      toast.error(error.response?.data?.message || 'Error al crear usuario');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4">Usuarios</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpen}>
          Nuevo Usuario
        </Button>
      </Box>

      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Nombre</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Perfil</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={4} align="center">Cargando...</TableCell></TableRow>
              ) : users.length === 0 ? (
                <TableRow><TableCell colSpan={4} align="center">No hay usuarios</TableCell></TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.id}</TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.profile === "admin" ? "Admin" : "Operador"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Nuevo Usuario</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2, display: 'grid', gap: 2 }}>
            <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} fullWidth disabled={creating} />
            <TextField label="Email" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth disabled={creating} />
            <TextField label="Contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} fullWidth disabled={creating} />
            <TextField
              select
              label="Perfil"
              value={profile}
              onChange={(e) => setProfile(e.target.value as 'admin' | 'user')}
              fullWidth
              disabled={creating}
            >
              <MenuItem value="user">Operador</MenuItem>
              <MenuItem value="admin">Admin</MenuItem>
            </TextField>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={creating}>Cancelar</Button>
          <Button onClick={handleCreate} variant="contained" disabled={creating}>Crear</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Users;
