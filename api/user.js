app.get('/api/v1/user/:id', async (req, res) => {
  const userId = req.params.id;
  await db('users').where({id: userId}).first()
    .then(user => res.status(200).json(user))
    .catch(error => res.status(500).json({ error }))
})

app.patch('/api/v1/user', async (req, res) => {
  const user = req.body
  await db('users').where('id', 1).update({
    username: user.name,
    password: user.password,
    location: user.location,
    email: user.email,
    phone: user.phone,
    state: user.state,
    updated_at: new Date()
  })
    .then(() => res.status(200).json(user))
    .catch(error => res.status(500).json({ error }))
})