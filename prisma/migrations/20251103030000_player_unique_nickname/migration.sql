-- Ensure unique nickname per game
CREATE UNIQUE INDEX "Player_gameId_nickname_key" ON "Player" ("gameId", "nickname");