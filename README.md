# NYC Pipe Types

This project started with a curiosity about all the weird pipes sticking out of New York City. I had this thought that I could walk around, take pictures of pipes, and cross-reference GPS data with PLUTO data from New York City to get information about the closest building, including that building's age, number of floors, and permitting stuff. How might pipes differ between new buildings and old buildings, or tall and short buildings? Is the way we build stuff nowadays boring, pipeswise? Stuff like that!

## Data Gathering and a Pivot

I decided to do a little data-gathering expedition. I took a meandering route and grabbed pictures (and video for re-creating 3D models of the pipes at some point). I walked around for three-ish hours and took almost 150 pictures. 

When I got back and brought the photos into QGIS, I found that the GPS accuracy was nowhere near good enough to accurately pair pipes with the buildings they belong to. I had to abandon that initial idea and pivot toward a different kind of analysis. 

I ended up simply categorizing the pipes into different buckets based on their function, doing a little bit of research into what the various pipes are for, and then just going through each bucket one by one to show people that pipes are cool and weird. 

## Process and Tools

* **QGIS & Illustrator:** I used QGIS to recreate the route that I walked based on the GPS coordinates of the photos I pulled in, as well as the GPS coordinates of the photos themselves. I used these coordinates to make a color-coded map of the locations of the pipes. I used Adobe Illustrator to simplify the maps visually. 
* **Pandas & Jupyter:** In QGIS, I manually categorized pipe types and created counts per category per photo, as some photos contained multiple pipes. Then, I exported an attribute table from QGIS as a CSV into a very basic Jupyter notebook, which I used to get simple totals–like the total number of pipes by type, and total pipes spotted overall.
* **Datawrapper:** I brought those totals over to Datawrapper so that I could make really simple, almost joke analysis charts and bar graphs. 
* **Pluto Data:** I also looked at the PLUTO data to pull in all the buildings that were taller than six stories to give a sense of scale for how many pipes there might actually be around the city.

## Future Scope

Ultimatley I feel this may not be a true data project on some level, but I had a lot of fun making it. If I were to continue working on this project, here is what I would want to do:

* **Interactive 3D Map:** I had the thought that if I could 3D scan some of these more interesting pipes, it would be cool to do an interactive map where you could click around at the points on the map and get a little sidebar with information about the individual pipes and buildings, examine and rotate the pipe in 3D, etc. I did not get to the interactive portion—it just felt like too much for the scale and scope of a project like this—but I would love to build it eventually.
* **Databases:** Imagining how I would attach a 3D model to my existing attritbute tables in QGIS, I started appreciating how data can get really complex, especially when you're manipulating it in multiple ways. A simple CSV table might not be enough. I'm vaguely aware that databases are things that exist, and I would be curious about looking into databases for a more robust way of containing all of the data one might generate.
* **Reporting and Fact-Checking:** I would love to do proper reporting and fact-checking, and bring in real expert analysis and narratives. Maybe even man-on-the-street type stuff about the pipes, just to make sure that I'm representing them accurately and helping people appreciate a part of the world around them, their city's infrastructure, which is so easy to take for granted.
