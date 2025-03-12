#!/bin/bash

# Deployment script for Nitter

# Add changes to git
git add .

# Commit changes
echo "Enter commit message:"
read commit_message
git commit -m "$commit_message"

# Push to repository
git push

echo "Changes pushed to repository."
echo "Now connect to your server and run the following commands:"
echo "cd /path/to/nitter"
echo "git pull"
echo "nimble build -d:release"
echo "systemctl restart nitter.service  # If using systemd"
echo "# Or restart using your preferred method" 