rmdir /s /q .vercel
call npx vercel link --project stl-nauru --yes
call npx vercel deploy --prod --yes
