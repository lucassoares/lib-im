curl.exe --request PUT `
  --user "grupo_123_bot_abc123:glpat-SEU-TOKEN" `
  --form "package=@C:\caminho\para\pacote.nupkg" `
  "https://gitlab.com/api/v4/projects/SEU_PROJECT_ID/packages/nuget/"


- dotnet nuget add source "https://nome-do-bot:$TAG_GITLAB_TOKEN@gitlab.com/api/v4/groups/125542281/-/packages/nuget/index.json"
      --name gitlab
