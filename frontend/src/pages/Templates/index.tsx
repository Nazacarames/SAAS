import { useEffect, useState } from 'react';
import { Box, Typography, Paper, Stack, TextField, Button, Grid } from '@mui/material';
import api from '../../services/api';

const Templates = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [name, setName] = useState('Bienvenida');
  const [category, setCategory] = useState('general');
  const [content, setContent] = useState('¡Hola {{nombre}}! Gracias por tu consulta.');

  const load = async () => {
    try { const { data } = await api.get('/ai/templates'); setRows(Array.isArray(data) ? data : []); } catch { setRows([]); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    await api.post('/ai/templates', { name, category, content, variablesJson: ['nombre'] });
    await load();
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Templates</Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Paper sx={{ p: 2 }}>
            <Stack spacing={1.2}>
              <TextField label='Nombre' value={name} onChange={(e) => setName(e.target.value)} />
              <TextField label='Categoría' value={category} onChange={(e) => setCategory(e.target.value)} />
              <TextField label='Contenido' multiline minRows={6} value={content} onChange={(e) => setContent(e.target.value)} />
              <Button variant='contained' onClick={create}>Crear template</Button>
            </Stack>
          </Paper>
        </Grid>
        <Grid item xs={12} md={7}>
          <Paper sx={{ p: 2 }}>
            <Typography variant='subtitle1'>Templates creados</Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>{rows.map((r) => (
              <Paper key={r.id} variant='outlined' sx={{ p: 1.2 }}>
                <Typography variant='body2' sx={{ fontWeight: 700 }}>{r.name} · {r.category}</Typography>
                <Typography variant='caption'>{r.content}</Typography>
              </Paper>
            ))}</Stack>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default Templates;
