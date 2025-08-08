document.addEventListener('DOMContentLoaded', () => {
    const podcastUrlInput = document.getElementById('podcastUrl');
    const generateBtn = document.getElementById('generateBtn');
    const resultBox = document.getElementById('result');
    const embedCodeTextarea = document.getElementById('embedCode');
    const copyBtn = document.getElementById('copyBtn');

    // Function to generate the iframe code
    function generateEmbedCode() {
        const fullUrl = podcastUrlInput.value;
        if (!fullUrl) {
            alert('Please enter a valid Apple Podcasts URL.');
            return;
        }

        // The URL needs to be converted to the embed format.
        // For example:
        // Original: https://podcasts.apple.com/us/podcast/relationship-goals/id1831950822
        // Embed: https://embed.podcasts.apple.com/us/podcast/relationship-goals/id1831950822?theme=dark
        
        let embedUrl = fullUrl.replace('podcasts.apple.com', 'embed.podcasts.apple.com');
        
        // Add the theme parameter if it's not already there
        if (!embedUrl.includes('?')) {
            embedUrl += '?theme=dark';
        } else if (!embedUrl.includes('theme=')) {
            embedUrl += '&theme=dark';
        }
        
        const iframeCode = `<iframe src="${embedUrl}" frameborder="0" allow="autoplay *; encrypted-media *;" style="overflow:hidden;background-color:transparent;"></iframe>`;

        embedCodeTextarea.value = iframeCode;
        resultBox.style.display = 'block'; // Show the result box
    }

    // Event listener for the Generate button
    generateBtn.addEventListener('click', generateEmbedCode);

    // Event listener for the Copy button
    copyBtn.addEventListener('click', () => {
        embedCodeTextarea.select();
        embedCodeTextarea.setSelectionRange(0, 99999); // For mobile devices
        document.execCommand('copy');
        alert('Embed code copied to clipboard!');
    });
});
