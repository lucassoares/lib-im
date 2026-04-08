curl.exe --request PUT `
  --user "grupo_123_bot_abc123:glpat-SEU-TOKEN" `
  --form "package=@C:\caminho\para\pacote.nupkg" `
  "https://gitlab.com/api/v4/projects/SEU_PROJECT_ID/packages/nuget/"
