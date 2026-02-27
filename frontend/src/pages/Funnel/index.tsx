import { useEffect, useState } from 'react';
import { Typography, Box, Paper, Grid } from '@mui/material';
import api from '../../services/api';

const Funnel = () => {
  const [stats, setStats] = useState({ nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get('/ai/funnel/stats');
        setStats(data || { nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });
      } catch {
        setStats({ nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });
      }
    };
    load();
  }, []);

  const cards = [
    { name: 'Nuevo', value: stats.nuevo },
    { name: 'Contactado', value: stats.contactado },
    { name: 'Calificado', value: stats.calificado },
    { name: 'Interesado', value: stats.interesado }
  ];

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Funnel</Typography>
      <Grid container spacing={2}>
        {cards.map((s) => (
          <Grid item xs={12} md={3} key={s.name}>
            <Paper sx={{ p: 2 }}>
              <Typography variant='caption'>{s.name}</Typography>
              <Typography variant='h5'>{s.value}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};

export default Funnel;
